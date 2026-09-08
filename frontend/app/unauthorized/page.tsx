import Link from 'next/link';

export default function UnauthorizedPage() {
  return (
    <div className="max-w-md mx-auto mt-24 text-center space-y-4">
      <h1 className="text-2xl font-bold text-red-600">Access Restricted</h1>
      <p className="text-gray-600">
        Your account role doesn't have access to this section of Jhar Samadhan.
      </p>
      <Link href="/" className="inline-block bg-blue-600 text-white px-4 py-2 rounded">
        Go to your dashboard
      </Link>
    </div>
  );
}