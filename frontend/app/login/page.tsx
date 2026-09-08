'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const ROLE_REDIRECTS: Record<string, string> = {
  citizen: '/citizen/submit',
  student: '/academic/opportunities',
  institution: '/academic/opportunities',
  ngo: '/industry/marketplace',
  govt_admin: '/admin/complaints',
};

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error || 'Login failed');
      return;
    }

    router.push(ROLE_REDIRECTS[data.role] ?? '/');
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md mx-auto mt-16 space-y-4">
      <h1 className="text-2xl font-bold">Login — Jhar Samadhan</h1>
      <input type="email" placeholder="Email" value={email}
        onChange={(e) => setEmail(e.target.value)} required className="w-full border p-2 rounded" />
      <input type="password" placeholder="Password" value={password}
        onChange={(e) => setPassword(e.target.value)} required className="w-full border p-2 rounded" />
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded">Login</button>
    </form>
  );
}