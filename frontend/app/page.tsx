import Link from 'next/link';

/* ============================================================================
 * Jhar Samadhan — module hub (/) for the SIH 26043 ecosystem.
 * Routes to every UI with its demo-auth hint pre-filled (identity headers are
 * stubbed with query params until real sessions exist — see each page header).
 * ==========================================================================*/

const MODULES = [
  {
    href: '/admin/complaints?admin=1',
    icon: '🗂️',
    title: 'Govt Admin — Complaint Queue',
    desc: 'Filter complaints by workflow status & domain, inspect duplicates and advance the state machine (Module 3).',
    hint: '?admin=1 (govt_admin)',
    tone: 'border-indigo-200 bg-indigo-50/60',
  },
  {
    href: '/academic/opportunities',
    icon: '🎓',
    title: 'Academic Opportunities Board',
    desc: 'Universities browse validated problems and adopt them with a formal proposal (Module 4).',
    hint: 'adoptable complaints, no auth needed to browse',
    tone: 'border-emerald-200 bg-emerald-50/60',
  },
  {
    href: '/industry/marketplace?pid=2',
    icon: '🤝',
    title: 'Industry & CSR Marketplace',
    desc: 'CSR / startups / MSMEs pledge grants, mentorship and pilots against approved prototypes (Module 5).',
    hint: '?pid=2 CSR · ?pid=3 startup · ?pid=4 MSME',
    tone: 'border-violet-200 bg-violet-50/60',
  },
  {
    href: '/academic/solutions?uid=5',
    icon: '🧪',
    title: 'Solution Submission Portal',
    desc: 'Approved teams submit versioned prototype documentation for verification (Module 6).',
    hint: '?uid=<team lead id>',
    tone: 'border-emerald-200 bg-emerald-50/60',
  },
  {
    href: '/admin/solutions?admin=1',
    icon: '✅',
    title: 'Govt Admin — Verification Queue',
    desc: 'Review prototypes, test links, approve / reject / request revision and close the loop (Module 7).',
    hint: '?admin=1 (govt_admin)',
    tone: 'border-amber-200 bg-amber-50/60',
  },
  {
    href: '/admin/analytics?admin=1',
    icon: '📊',
    title: 'Analytics Command Center',
    desc: 'District & domain KPIs, pendency brackets, HEI participation, funding and export (Module 8).',
    hint: '?admin=1 (govt_admin)',
    tone: 'border-slate-300 bg-slate-100/70',
  },
];

const API_ROUTES = [
  ['POST /api/complaints', 'Citizen intake (multipart WebP + geo)'],
  ['GET /api/admin/complaints', 'Admin complaint queue'],
  ['POST /api/admin/complaints/[id]/advance', 'State-machine advance'],
  ['GET+POST /api/claims', 'Opportunities board + claim ingestion'],
  ['GET+POST /api/solutions', 'Solution portal + iteration ingestion'],
  ['GET+POST /api/industry/partnerships', 'Marketplace catalog + pledges'],
  ['GET /api/admin/solutions', 'Verification queue'],
  ['PATCH /api/admin/solutions/[id]/review', 'Prototype decision + notifications'],
  ['GET /api/admin/analytics', 'Aggregated impact metrics'],
];

export default function HubPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10">
      <header className="text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-indigo-700">
          SIH 26043 · Government of Jharkhand
        </p>
        <h1 className="mt-1 text-3xl font-bold text-slate-900">
          Jhar Samadhan — Module Hub
        </h1>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-500">
          Crowdsourcing-to-resolution ecosystem. Pick a module to open its UI —
          each card pre-fills the demo identity (admin / partner / team lead)
          used until real session auth lands.
        </p>
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MODULES.map((module) => (
          <Link
            key={module.href}
            href={module.href}
            className={`rounded-2xl border p-5 shadow-sm ring-1 ring-transparent transition hover:-translate-y-0.5 hover:shadow-md ${module.tone}`}
          >
            <p className="text-2xl">{module.icon}</p>
            <h2 className="mt-2 text-sm font-bold text-slate-900">{module.title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">{module.desc}</p>
            <p className="mt-3 inline-block rounded-full bg-white/80 px-2.5 py-1 font-mono text-[10px] text-slate-500 ring-1 ring-slate-200">
              {module.hint}
            </p>
          </Link>
        ))}
      </section>

      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">API surface</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          All handlers require a <code className="font-mono">DATABASE_URL</code> and send identity via the
          <code className="font-mono"> x-admin-id</code> / <code className="font-mono">x-user-id</code> headers.
        </p>
        <div className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
          {API_ROUTES.map(([route, desc]) => (
            <p key={route} className="text-xs">
              <code className="font-semibold text-indigo-700">{route}</code>
              <span className="ml-2 text-slate-500">{desc}</span>
            </p>
          ))}
        </div>
      </section>
    </main>
  );
}
