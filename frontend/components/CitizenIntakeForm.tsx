'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/* ============================================================================
 * CitizenIntakeForm.tsx
 *
 * Mobile-first, chat-like intake form for reporting civic issues.
 *  - Asks, one at a time: title -> description -> category (optional)
 *    -> photos (optional) -> privacy (Public / Anonymous) -> review.
 *  - Auto-fetches coordinates via the HTML5 Geolocation API on mount.
 *  - Compresses photo uploads to WebP (< 500 KB) client-side with the
 *    Canvas API, before anything is sent to a server.
 *  - Submits a multipart POST to `/api/complaints` by default (override with
 *    `apiEndpoint` or `onSubmit`), managing offline/error/success states.
 *  - Surfaces semantic duplicate feedback: when the API returns a `cluster`
 *    payload, asks the citizen whether they want to upvote the earlier report.
 * ==========================================================================*/

/* ----------------------------------------------------------------------------
 * Shared types (exported so the future API route can reuse them)
 * -------------------------------------------------------------------------- */

export interface CategoryOption {
  code: string;
  label: string;
}

export interface WebpPhoto {
  /** Ready-to-upload WebP file, guaranteed < 500 KB. */
  file: File;
  /** Local object URL used for previews only (never uploaded). */
  previewUrl: string;
  size: number; // bytes
  width: number;
  height: number;
}

export interface IntakePayload {
  title: string;
  description: string;
  categoryCode: string | null; // null = citizen skipped the optional category
  categoryLabel: string | null;
  isAnonymous: boolean;
  submissionMode: 'text' | 'voice' | 'image'; // 'voice' reserved for the Bhashini pipeline
  photos: WebpPhoto[];
  latitude: number | null;
  longitude: number | null;
  locationAccuracyM: number | null;
  locationStatus: string; // e.g. 'ready' | 'denied' | 'unavailable'
}

export interface DuplicateCluster {
  parentComplaintId: number;
  similarity: number;
}

export interface SubmitOutcome {
  ok: boolean;
  httpStatus?: number;
  serverError?: string;
  /** true when the request itself failed (offline / network drop / timeout). */
  networkError?: boolean;
  /** Set on success when the intake API linked the report to a duplicate. */
  cluster?: DuplicateCluster | null;
}

export interface CitizenIntakeFormProps {
  /** Optional custom submitter; defaults to a multipart POST to `apiEndpoint`. */
  onSubmit?: (payload: IntakePayload) => Promise<SubmitOutcome>;
  /** Route the default submitter posts to. */
  apiEndpoint?: string;
  /** Citizen id sent as `x-user-id` until real session auth exists. */
  userId?: string | number;
  maxPhotos?: number;
}

/* ----------------------------------------------------------------------------
 * Fixed category taxonomy (must mirror the Categories table seed)
 * -------------------------------------------------------------------------- */

export const CATEGORY_OPTIONS: CategoryOption[] = [
  { code: 'AGR', label: 'Agriculture & Farmer Welfare' },
  { code: 'WAT', label: 'Water & Sanitation' },
  { code: 'HLT', label: 'Health & Wellness' },
  { code: 'EDU', label: 'Education & Skill Development' },
  { code: 'PWR', label: 'Energy & Electricity' },
  { code: 'INF', label: 'Roads & Infrastructure' },
  { code: 'SWM', label: 'Waste Management' },
  { code: 'OTH', label: 'Something else' },
];

/* ----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const MAX_WEBP_BYTES = 500 * 1024; // strictly under 500 KB (499 KB max)
const MAX_PHOTOS_DEFAULT = 4;
const DEFAULT_API_ENDPOINT = '/api/complaints';
const REQUEST_TIMEOUT_MS = 20_000; // abort long-hanging uploads
const MIN_TITLE = 5;
const MAX_TITLE = 300;
const MIN_DESCRIPTION = 10;

type StepKey =
  | 'title'
  | 'description'
  | 'category'
  | 'photos'
  | 'privacy';

const STEP_ORDER: StepKey[] = [
  'title',
  'description',
  'category',
  'photos',
  'privacy',
];

const STEP_META: Record<
  StepKey,
  { question: string; hint?: string }
> = {
  title: {
    question: 'What would you like to report? Give it a short title.',
    hint: `${MIN_TITLE}–${MAX_TITLE} characters`,
  },
  description: {
    question: "Tell me more about what's happening.",
    hint: 'What did you see, where exactly, and since when?',
  },
  category: {
    question: 'Does it fit one of these categories?',
    hint: "Optional — we can also figure it out ourselves.",
  },
  photos: {
    question: 'Add a photo as evidence?',
    hint: 'Up to 4 photos, compressed to WebP under 500 KB right in your browser.',
  },
  privacy: {
    question: 'Should this report show your name publicly?',
  },
};

type Privacy = 'public' | 'anonymous';

const PRIVACY_LABEL: Record<Privacy, string> = {
  public: 'Public',
  anonymous: 'Anonymous',
};

const REVIEW_LABELS: Record<StepKey, string> = {
  title: 'Issue title',
  description: 'Description',
  category: 'Category',
  photos: 'Evidence',
  privacy: 'Privacy',
};

/* ----------------------------------------------------------------------------
 * Canvas / WebP compression utilities
 * -------------------------------------------------------------------------- */

function isWebpSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  return canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(`Could not read "${file.name}". It may be corrupted or not an image.`)
      );
    };
    image.src = url;
  });
}

/** Draws the source into a fresh canvas whose longest side <= maxDimension. */
function renderScaled(
  source: HTMLImageElement,
  maxDimension: number
): HTMLCanvasElement {
  const sourceWidth = source.naturalWidth || 1;
  const sourceHeight = source.naturalHeight || 1;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialise the image canvas.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function canvasToWebpBlob(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
}

/**
 * Resizes + re-encodes an image to WebP, iterating over quality and
 * dimensions until the result is strictly below 500 KB.
 */
export async function compressToWebp(
  file: File,
  maxBytes: number = MAX_WEBP_BYTES
): Promise<WebpPhoto> {
  if (!isWebpSupported()) {
    throw new Error(
      'WebP encoding is not supported in this browser. Please use a modern browser (Chrome, Edge, Firefox, or Safari 16+).'
    );
  }
  const source = await loadImage(file);

  let quality = 0.8;
  let maxDimension = 1600; // initial downscale for very large camera photos
  let blob: Blob | null = null;
  let width = 0;
  let height = 0;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const canvas = renderScaled(source, maxDimension);
    width = canvas.width;
    height = canvas.height;
    blob = await canvasToWebpBlob(canvas, quality);
    if (blob && blob.size < maxBytes) break;

    // Strategy: first squeeze quality, then start shrinking dimensions.
    if (quality > 0.4) {
      quality = Math.max(0.4, quality - 0.15);
    } else if (maxDimension > 240) {
      maxDimension = Math.max(240, Math.round(maxDimension * 0.75));
      quality = 0.72; // smaller canvases need less aggressive lossiness
    } else {
      break; // cannot shrink any further
    }
  }

  if (!blob || blob.size >= maxBytes) {
    throw new Error(
      `Could not compress "${file.name}" below 500 KB. Please try a smaller photo.`
    );
  }

  const baseName = file.name.replace(/\.[^.]+$/i, '') || 'photo';
  const webpFile = new File([blob], `${baseName}.webp`, { type: 'image/webp' });
  return {
    file: webpFile,
    previewUrl: URL.createObjectURL(webpFile),
    size: webpFile.size,
    width,
    height,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function isDuplicateCluster(value: unknown): value is DuplicateCluster {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { parentComplaintId?: unknown; similarity?: unknown };
  return (
    typeof candidate.parentComplaintId === 'number' &&
    typeof candidate.similarity === 'number'
  );
}

/* ----------------------------------------------------------------------------
 * useGeolocation - silently fetches coordinates once on mount
 * -------------------------------------------------------------------------- */

type GeoState =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'ready'; latitude: number; longitude: number; accuracy: number }
  | { status: 'denied' }
  | { status: 'unavailable'; error: string };

function useGeolocation() {
  const [geo, setGeo] = useState<GeoState>({ status: 'idle' });

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGeo({
        status: 'unavailable',
        error: 'Geolocation is not supported by this browser or context.',
      });
      return;
    }
    setGeo({ status: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setGeo({
          status: 'ready',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setGeo({ status: 'denied' });
        } else {
          setGeo({ status: 'unavailable', error: error.message });
        }
      },
      // Silent single-shot grab on mount: no watch, low power profile.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 }
    );
  }, []);

  // Auto-fetch on mount (the browser may still show its own permission prompt).
  useEffect(() => {
    locate();
  }, [locate]);

  return { geo, retry: locate };
}

/* ----------------------------------------------------------------------------
 * useOnline - tracks browser connectivity for PWA offline handling
 * -------------------------------------------------------------------------- */

function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}

/* ----------------------------------------------------------------------------
 * Component
 * -------------------------------------------------------------------------- */

type AnswerValue =
  | string
  | CategoryOption
  | null
  | WebpPhoto[]
  | Privacy;

type Answers = Partial<Record<StepKey, AnswerValue>>;

export default function CitizenIntakeForm({
  onSubmit,
  apiEndpoint = DEFAULT_API_ENDPOINT,
  userId,
  maxPhotos = MAX_PHOTOS_DEFAULT,
}: CitizenIntakeFormProps) {
  /* ---- state ----------------------------------------------------------- */
  const { geo, retry: retryGeolocation } = useGeolocation();
  const isOnline = useOnline();

  const [answers, setAnswers] = useState<Answers>({});
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [pickedPhotos, setPickedPhotos] = useState<WebpPhoto[]>([]);
  const [processingPhotos, setProcessingPhotos] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateCluster | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [upvoteNote, setUpvoteNote] = useState<string | null>(null);
  const [voting, setVoting] = useState(false);

  /* ---- refs ------------------------------------------------------------ */
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]); // preview URLs to revoke on unmount

  // Always keep the newest chat content in view.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [
    answers,
    geo.status,
    processingPhotos,
    pickedPhotos.length,
    submitted,
    duplicate?.parentComplaintId,
    submitError,
    upvoteNote,
    isOnline,
    voting,
  ]);

  // Revoke every preview object URL we created when the component unmounts.
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  /* ---- derived step progression ---------------------------------------- */
  const answeredKeys = STEP_ORDER.filter((key) => answers[key] !== undefined);
  const currentKey: StepKey | null =
    STEP_ORDER.find((key) => answers[key] === undefined) ?? null;
  const allAnswered = currentKey === null;
  const stepProgress = answeredKeys.length;

  // Reset the text drafts whenever the conversation moves to a text step.
  useEffect(() => {
    if (currentKey === 'title') setDraftTitle('');
    if (currentKey === 'description') setDraftDescription('');
  }, [currentKey]);

  /* ---- step answer handlers -------------------------------------------- */
  const commitTitle = () => {
    const title = draftTitle.trim();
    if (title.length < MIN_TITLE || title.length > MAX_TITLE) return;
    setAnswers((prev) => ({ ...prev, title }));
    setDraftTitle('');
  };

  const commitDescription = () => {
    const description = draftDescription.trim();
    if (description.length < MIN_DESCRIPTION) return;
    setAnswers((prev) => ({ ...prev, description }));
    setDraftDescription('');
  };

  const chooseCategory = (option: CategoryOption) => {
    setAnswers((prev) => ({ ...prev, category: option }));
  };

  const skipCategory = () => {
    setAnswers((prev) => ({ ...prev, category: null }));
  };

  const choosePrivacy = (privacy: Privacy) => {
    setAnswers((prev) => ({ ...prev, privacy }));
  };

  const finishPhotos = () => {
    if (pickedPhotos.length === 0) return;
    setAnswers((prev) => ({ ...prev, photos: pickedPhotos }));
  };

  const skipPhotos = () => {
    setAnswers((prev) => ({ ...prev, photos: null }));
  };

  /** Pull a step back to the front of the conversation to re-answer it. */
  const editAnswer = (key: StepKey) => {
    // Restore already-picked photos so re-answering the step can resume them.
    if (key === 'photos') {
      const old = answers.photos;
      setPickedPhotos(Array.isArray(old) ? old : []);
    }
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /* ---- photo picking + compression -------------------------------------- */
  const handlePickPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = ''; // allow re-selecting the same file
    if (picked.length === 0) return;

    if (pickedPhotos.length + picked.length > maxPhotos) {
      setPhotoError(`You can attach up to ${maxPhotos} photos.`);
      return;
    }

    setPhotoError(null);
    setProcessingPhotos(true);
    try {
      for (const file of picked) {
        try {
          const photo = await compressToWebp(file);
          objectUrlsRef.current.push(photo.previewUrl);
          setPickedPhotos((prev) => [...prev, photo]);
        } catch (error) {
          setPhotoError(
            error instanceof Error ? error.message : 'Photo compression failed.'
          );
        }
      }
    } finally {
      setProcessingPhotos(false);
    }
  };

  const removePhoto = (previewUrl: string) => {
    URL.revokeObjectURL(previewUrl);
    setPickedPhotos((prev) => prev.filter((p) => p.previewUrl !== previewUrl));
  };

  /* ---- submission -------------------------------------------------------- */
  const buildPayload = (): IntakePayload | null => {
    if (!allAnswered) return null;
    const title = answers.title;
    const description = answers.description;
    if (typeof title !== 'string' || typeof description !== 'string') return null;

    const category = answers.category as CategoryOption | null | undefined;
    const privacy = answers.privacy as Privacy | undefined;
    const photos = (answers.photos as WebpPhoto[] | null | undefined) ?? [];
    const coordsReady = geo.status === 'ready';

    return {
      title: title.trim(),
      description: description.trim(),
      categoryCode: category?.code ?? null,
      categoryLabel: category?.label ?? null,
      isAnonymous: privacy === 'anonymous',
      submissionMode: photos.length > 0 ? 'image' : 'text',
      photos,
      latitude: coordsReady ? geo.latitude : null,
      longitude: coordsReady ? geo.longitude : null,
      locationAccuracyM: coordsReady ? Math.round(geo.accuracy) : null,
      locationStatus: geo.status,
    };
  };

  /**
   * Default submitter: multipart POST to `apiEndpoint` with the fields the
   * intake route expects (title, description, categoryCode, privacy,
   * latitude/longitude, and the pre-compressed WebP photos).
   */
  const defaultSubmit = async (
    payload: IntakePayload
  ): Promise<SubmitOutcome> => {
    const formData = new FormData();
    formData.append('title', payload.title);
    formData.append('description', payload.description);
    formData.append('categoryCode', payload.categoryCode ?? '');
    formData.append('privacy', payload.isAnonymous ? 'anonymous' : 'public');
    if (payload.latitude !== null && payload.longitude !== null) {
      formData.append('latitude', String(payload.latitude));
      formData.append('longitude', String(payload.longitude));
    }
    // Append every compressed WebP file under the 'photos' field name.
    payload.photos.forEach((photo) => {
      formData.append('photos', photo.file, photo.file.name);
    });

    // Demo identity until real session auth replaces the x-user-id header.
    const headers: Record<string, string> = {};
    if (userId !== undefined && userId !== null) {
      headers['x-user-id'] = String(userId);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(apiEndpoint, {
          method: 'POST',
          headers,
          body: formData, // multipart/form-data boundary is set automatically
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const data = (await response.json().catch(() => null)) as {
        error?: string;
        cluster?: unknown;
      } | null;

      if (!response.ok) {
        return {
          ok: false,
          httpStatus: response.status,
          serverError:
            data?.error ?? `Submission failed (HTTP ${response.status}).`,
        };
      }

      // Surface the semantic duplicate cluster, when the API found one.
      const clusterValue: unknown = data?.cluster;
      return {
        ok: true,
        cluster: isDuplicateCluster(clusterValue) ? clusterValue : null,
      };
    } catch {
      // fetch rejects on offline / network drops / abort (timeout).
      return { ok: false, networkError: true };
    }
  };

  const submitIntake = (payload: IntakePayload): Promise<SubmitOutcome> =>
    onSubmit ? onSubmit(payload) : defaultSubmit(payload);

  const handleSubmit = async () => {
    const payload = buildPayload();
    if (!payload || submitting) return;

    if (!isOnline) {
      setSubmitError(
        "You're offline. Reconnect and press retry — nothing you typed is lost."
      );
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setDuplicate(null);
    setUpvoteNote(null);

    const outcome = await submitIntake(payload);
    setSubmitting(false);

    if (!outcome.ok) {
      if (outcome.networkError) {
        setSubmitError(
          "We couldn't reach the server — your connection may have dropped. Your report is still here; press retry once you're back online."
        );
      } else {
        setSubmitError(
          outcome.serverError ?? `Submission failed (HTTP ${outcome.httpStatus}).`
        );
      }
      return;
    }

    if (outcome.cluster) {
      // Wait for the citizen's decision before showing the success screen.
      setDuplicate(outcome.cluster);
    } else {
      setSubmitted(true);
    }
  };

  /** Citizen keeps their report; it is already linked to the duplicate. */
  const keepMyReport = () => {
    if (duplicate) {
      setUpvoteNote(
        `Your report was linked to earlier report #${duplicate.parentComplaintId} — both will be resolved together.`
      );
    }
    setDuplicate(null);
    setSubmitted(true);
  };

  /** Citizen upvotes the earlier report (best-effort until that route exists). */
  const handleUpvoteInstead = async () => {
    if (!duplicate || voting) return;
    setVoting(true);
    setUpvoteNote(null);

    const headers: Record<string, string> = {};
    if (userId !== undefined && userId !== null) {
      headers['x-user-id'] = String(userId);
    }
    try {
      const response = await fetch(
        `${apiEndpoint}/${duplicate.parentComplaintId}/upvote`,
        { method: 'POST', headers }
      );
      if (response.ok) {
        setUpvoteNote(
          `Thanks! Your upvote was recorded on report #${duplicate.parentComplaintId}.`
        );
      } else {
        setUpvoteNote(
          `Upvoting isn't available yet (HTTP ${response.status}). Your report is still linked to #${duplicate.parentComplaintId} and both will be resolved together.`
        );
      }
    } catch {
      setUpvoteNote(
        `You appear to be offline. Your report is still linked to #${duplicate.parentComplaintId} — retry the upvote once you're back online.`
      );
    } finally {
      setVoting(false);
      setDuplicate(null);
      setSubmitted(true);
    }
  };

  const resetForm = () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];
    setPickedPhotos([]);
    setAnswers({});
    setPhotoError(null);
    setSubmitError(null);
    setDuplicate(null);
    setUpvoteNote(null);
    setSubmitted(false);
  };

  /* ---- render helpers ----------------------------------------------------- */

  const geoPill = (() => {
    switch (geo.status) {
      case 'ready':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
            📍 Location captured · {geo.latitude.toFixed(4)}, {geo.longitude.toFixed(4)}
          </span>
        );
      case 'locating':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-800">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
            Detecting location…
          </span>
        );
      case 'denied':
        return (
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
            📍 Location blocked
            <button
              type="button"
              onClick={retryGeolocation}
              className="font-semibold text-amber-900 underline underline-offset-2"
            >
              Allow
            </button>
          </span>
        );
      case 'unavailable':
        return (
          <span className="inline-flex items-center gap-2 rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-600">
            📍 Location unavailable
            <button
              type="button"
              onClick={retryGeolocation}
              className="font-semibold text-slate-800 underline underline-offset-2"
            >
              Retry
            </button>
          </span>
        );
      default:
        return null;
    }
  })();

  const renderAnswerContent = (key: StepKey) => {
    const value = answers[key];
    switch (key) {
      case 'title':
      case 'description':
        return (
          <p className="whitespace-pre-wrap break-words">{String(value)}</p>
        );
      case 'category': {
        const category = value as CategoryOption | null;
        return category ? (
          <p>{category.label}</p>
        ) : (
          <p className="italic opacity-70">Skipped — left for AI triage</p>
        );
      }
      case 'photos': {
        const photos = value as WebpPhoto[] | null;
        if (!photos || photos.length === 0) {
          return (
            <p className="italic opacity-70">
              {photos ? 'No photos attached' : 'Skipped — no photos'}
            </p>
          );
        }
        const totalBytes = photos.reduce((sum, p) => sum + p.size, 0);
        return (
          <div>
            <p>
              {photos.length} photo{photos.length > 1 ? 's' : ''} ·{' '}
              {formatBytes(totalBytes)} total
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {photos.map((photo) => (
                <img
                  key={photo.previewUrl}
                  src={photo.previewUrl}
                  alt="Attached evidence"
                  className="h-16 w-16 rounded-lg object-cover ring-1 ring-black/10"
                />
              ))}
            </div>
          </div>
        );
      }
      case 'privacy': {
        const privacy = value as Privacy;
        return (
          <p>
            {privacy === 'anonymous' ? '🕶️ Anonymous' : '🙂 Public'}{' '}
            <span className="opacity-75">· {PRIVACY_LABEL[privacy]}</span>
          </p>
        );
      }
      default:
        return null;
    }
  };

  const renderControlsForStep = (key: StepKey) => {
    switch (key) {
      case 'category':
        return (
          <div className="mt-3">
            <div className="grid grid-cols-2 gap-2">
              {CATEGORY_OPTIONS.map((option) => (
                <button
                  key={option.code}
                  type="button"
                  onClick={() => chooseCategory(option)}
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-left text-sm font-medium text-slate-800 shadow-sm transition hover:border-emerald-400 hover:bg-emerald-50 active:scale-[0.98]"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={skipCategory}
              className="mt-3 text-sm font-medium text-slate-500 underline underline-offset-2"
            >
              Skip for now →
            </button>
          </div>
        );
      case 'photos':
        return (
          <div className="mt-3">
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-emerald-400 hover:bg-emerald-50 active:scale-[0.98]">
                📷 {pickedPhotos.length > 0 ? 'Add more photos' : 'Attach a photo'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  className="sr-only"
                  onChange={handlePickPhotos}
                  disabled={processingPhotos || pickedPhotos.length >= maxPhotos}
                />
              </label>
              {processingPhotos && (
                <span className="text-sm text-slate-500">
                  Compressing to WebP…
                </span>
              )}
            </div>

            {photoError && (
              <p className="mt-2 text-xs font-medium text-rose-600">{photoError}</p>
            )}

            {pickedPhotos.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {pickedPhotos.map((photo) => (
                  <div
                    key={photo.previewUrl}
                    className="group relative h-20 w-20 overflow-hidden rounded-xl ring-1 ring-black/10"
                  >
                    <img
                      src={photo.previewUrl}
                      alt="Selected"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-[10px] font-semibold text-white">
                      {formatBytes(photo.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePhoto(photo.previewUrl)}
                      aria-label="Remove photo"
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs font-bold text-white transition hover:bg-rose-600"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 flex items-center gap-4 text-sm font-medium">
              <button
                type="button"
                onClick={finishPhotos}
                disabled={pickedPhotos.length === 0 || processingPhotos}
                className="rounded-full bg-emerald-600 px-4 py-1.5 text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pickedPhotos.length > 0 ? 'Done — send photos' : 'Done'}
              </button>
              <button
                type="button"
                onClick={skipPhotos}
                className="text-slate-500 underline underline-offset-2"
              >
                No photos →
              </button>
            </div>
          </div>
        );
      case 'privacy':
        return (
          <div className="mt-3 grid gap-2">
            <button
              type="button"
              onClick={() => choosePrivacy('public')}
              className="flex items-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-left shadow-sm transition hover:border-emerald-400 hover:bg-emerald-50 active:scale-[0.98]"
            >
              <span className="text-2xl">🙂</span>
              <span>
                <span className="block text-sm font-semibold text-slate-800">
                  Public
                </span>
                <span className="block text-xs text-slate-500">
                  Your name is visible with the report
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => choosePrivacy('anonymous')}
              className="flex items-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 text-left shadow-sm transition hover:border-emerald-400 hover:bg-emerald-50 active:scale-[0.98]"
            >
              <span className="text-2xl">🕶️</span>
              <span>
                <span className="block text-sm font-semibold text-slate-800">
                  Anonymous
                </span>
                <span className="block text-xs text-slate-500">
                  Your identity stays hidden from the public
                </span>
              </span>
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  const textStepActive = currentKey === 'title' || currentKey === 'description';
  const titleValid =
    draftTitle.trim().length >= MIN_TITLE && draftTitle.trim().length <= MAX_TITLE;
  const descriptionValid = draftDescription.trim().length >= MIN_DESCRIPTION;

  const bubble = (from: 'assistant' | 'user', children: ReactNode) => (
    <div
      className={`flex w-full ${from === 'user' ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`flex max-w-[86%] items-end gap-2 ${from === 'user' ? 'flex-row-reverse' : ''}`}
      >
        <span
          aria-hidden
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm shadow-sm ${
            from === 'user' ? 'bg-emerald-100' : 'bg-slate-200'
          }`}
        >
          {from === 'user' ? '🧑' : '🏛️'}
        </span>
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
            from === 'user'
              ? 'rounded-br-md bg-emerald-600 text-white'
              : 'rounded-bl-md border border-slate-200 bg-white text-slate-800'
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );

  /* ------------------------------------------------------------------------ */
  return (
    <div className="flex h-[100dvh] flex-col bg-slate-100">
      {/* ---- header ---- */}
      <header className="border-b border-slate-200 bg-white px-4 pb-2 pt-3 shadow-sm">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-slate-900">
              Report an issue
            </h1>
            <p className="text-xs text-slate-500">
              Step {Math.min(stepProgress + 1, STEP_ORDER.length)} of{' '}
              {STEP_ORDER.length} · {geoPill}
            </p>
          </div>
        </div>
        {/* progress dots */}
        <div className="mx-auto mt-2 flex w-full max-w-xl gap-1.5">
          {STEP_ORDER.map((key) => {
            const done = answers[key] !== undefined;
            const active = key === currentKey;
            return (
              <span
                key={key}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  done
                    ? 'bg-emerald-500'
                    : active
                      ? 'bg-emerald-300'
                      : 'bg-slate-200'
                }`}
              />
            );
          })}
        </div>
      </header>

      {/* ---- offline banner (PWA) ---- */}
      {!isOnline && (
        <div className="border-b border-amber-200 bg-amber-100 px-4 py-2 text-center text-xs font-medium text-amber-800">
          📡 You're offline — reports will wait until you reconnect. Your
          answers are safe.
        </div>
      )}

      {/* ---- chat transcript ---- */}
      <main className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-3">
          {bubble(
            'assistant',
            <p>
              Namaste! 🙏 Tell us what's happening in your area and we'll route it
              to the right department. This takes less than a minute.
            </p>
          )}

          {answeredKeys.map((key) => (
            <Fragment key={key}>
              {bubble('assistant', <p>{STEP_META[key].question}</p>)}
              {bubble('user', renderAnswerContent(key))}
            </Fragment>
          ))}

          {currentKey && (
            <Fragment key={currentKey}>
              {bubble(
                'assistant',
                <div>
                  <p>{STEP_META[currentKey].question}</p>
                  {STEP_META[currentKey].hint && (
                    <p className="mt-1 text-xs text-slate-400">
                      {STEP_META[currentKey].hint}
                    </p>
                  )}
                  {renderControlsForStep(currentKey)}
                </div>
              )}
            </Fragment>
          )}

          {/* ---- review + submit card ---- */}
          {allAnswered && !submitted && !duplicate && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-bold text-slate-900">
                Review &amp; submit
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Location: {geo.status === 'ready' ? 'auto-detected ✓' : 'not available'}
              </p>
              <dl className="mt-3 divide-y divide-slate-100">
                {STEP_ORDER.map((key) => (
                  <div key={key} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        {REVIEW_LABELS[key]}
                      </dt>
                      <dd className="mt-0.5 truncate text-sm text-slate-800">
                        {renderAnswerContent(key)}
                      </dd>
                    </div>
                    <button
                      type="button"
                      onClick={() => editAnswer(key)}
                      className="shrink-0 text-xs font-semibold text-emerald-700 underline underline-offset-2"
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </dl>

              {geo.status === 'denied' && (
                <p className="mt-1 text-xs text-amber-600">
                  Location permission is blocked, so the report won't include
                  coordinates. You can{' '}
                  <button
                    type="button"
                    onClick={retryGeolocation}
                    className="font-semibold underline underline-offset-2"
                  >
                    try allowing it again
                  </button>
                  .
                </p>
              )}

              {submitError && (
                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs font-medium text-rose-700">
                  <span>{submitError}</span>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={submitting}
                    className="ml-2 font-bold underline underline-offset-2"
                  >
                    Retry
                  </button>
                </div>
              )}

              {!isOnline && (
                <p className="mt-2 text-xs text-amber-600">
                  Waiting for a connection before submitting…
                </p>
              )}

              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !isOnline}
                className="mt-4 w-full rounded-2xl bg-emerald-600 px-4 py-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Submitting…' : 'Submit report →'}
              </button>
            </div>
          )}

          {/* ---- semantic duplicate notice ---- */}
          {duplicate && !submitted && (
            <div
              role="status"
              className="rounded-2xl border border-amber-300 bg-amber-50 p-4 shadow-sm"
            >
              <p className="text-sm font-semibold text-amber-900">
                A similar issue has already been reported nearby. Would you like
                to upvote it instead?
              </p>
              <p className="mt-1 text-xs text-amber-700">
                Your report was stored and linked to report #{duplicate.parentComplaintId} (
                {Math.round(duplicate.similarity * 100)}% similar) — either way it will be
                resolved together with the earlier one.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={handleUpvoteInstead}
                  disabled={voting || !isOnline}
                  className="rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {voting ? 'Recording…' : '👍 Yes, upvote the earlier report'}
                </button>
                <button
                  type="button"
                  onClick={keepMyReport}
                  disabled={voting}
                  className="rounded-full border border-amber-400 bg-white px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
                >
                  No, keep my report
                </button>
              </div>
              {!isOnline && (
                <p className="mt-2 text-xs font-medium text-amber-700">
                  You're offline — reconnect to upvote, or keep your report.
                </p>
              )}
            </div>
          )}

          {/* ---- success ---- */}
          {submitted && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
              <p className="text-3xl">🎉</p>
              <h2 className="mt-2 text-base font-bold text-emerald-900">
                Report submitted!
              </h2>
              {upvoteNote && (
                <p className="mt-1 text-xs font-medium text-emerald-800">
                  {upvoteNote}
                </p>
              )}
              <p className="mt-1 text-sm text-emerald-800">
                You'll get an email alert at every step of the resolution.
              </p>
              <button
                type="button"
                onClick={resetForm}
                className="mt-4 rounded-full border border-emerald-300 bg-white px-5 py-2 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-100"
              >
                Report another issue
              </button>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </main>

      {/* ---- composer (only for free-text steps) ---- */}
      {textStepActive && !submitted && (
        <footer className="border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.04)]">
          <div className="mx-auto w-full max-w-xl">
            {currentKey === 'title' ? (
              <div>
                <div className="flex items-end gap-2">
                  <input
                    type="text"
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === 'Enter' && titleValid) {
                        event.preventDefault();
                        commitTitle();
                      }
                    }}
                    maxLength={MAX_TITLE}
                    placeholder="e.g. Water pipeline leaking for a week"
                    autoFocus
                    className="flex-1 rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-200"
                  />
                  <button
                    type="button"
                    onClick={commitTitle}
                    disabled={!titleValid}
                    className="rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>
                <p className="mt-1 pl-1 text-xs text-slate-400">
                  {draftTitle.trim().length}/{MAX_TITLE} ·{' '}
                  {draftTitle.trim().length > 0 &&
                  draftTitle.trim().length < MIN_TITLE
                    ? `at least ${MIN_TITLE} characters`
                    : ''}
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-end gap-2">
                  <textarea
                    value={draftDescription}
                    onChange={(event) => setDraftDescription(event.target.value)}
                    rows={3}
                    placeholder="Describe the issue…"
                    autoFocus
                    className="max-h-40 flex-1 resize-none rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-200"
                  />
                  <button
                    type="button"
                    onClick={commitDescription}
                    disabled={!descriptionValid}
                    className="rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Send
                  </button>
                </div>
                <p className="mt-1 pl-1 text-xs text-slate-400">
                  {draftDescription.trim().length > 0 &&
                  draftDescription.trim().length < MIN_DESCRIPTION
                    ? `at least ${MIN_DESCRIPTION} characters`
                    : 'Press Send when you are done.'}
                </p>
              </div>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
