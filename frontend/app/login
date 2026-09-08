'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabaseClient';

// Maps each role to the module they should land on
const ROLE_REDIRECTS: Record<string, string> = {
  citizen: '/citizen/submit',           // your apps/citizen-web-pwa entry
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
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email, password });
    if (loginError) {
      setError(loginError.message);
      return;
    }

    // Fetch role from your users table using the auth_id
    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('auth_id', data.user.id)
      .single();

    const destination = ROLE_REDIRECTS[profile?.role ?? 'citizen'] ?? '/';
    router.push(destination);
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md mx-auto mt-16 space-y-4">
      <h1 className="text-2xl font-bold">Login — Jhar Samadhan</h1>
      <input
        type="email" placeholder="Email" value={email}
        onChange={(e) => setEmail(e.target.value)} required
        className="w-full border p-2 rounded"
      />
      <input
        type="password" placeholder="Password" value={password}
        onChange={(e) => setPassword(e.target.value)} required
        className="w-full border p-2 rounded"
      />
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded">
        Login
      </button>
    </form>
  );
}