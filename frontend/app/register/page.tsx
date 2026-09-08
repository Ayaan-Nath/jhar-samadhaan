'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabaseClient'; // adjust path to your existing client

const ROLES = [
  { value: 'citizen', label: 'Citizen' },
  { value: 'student', label: 'Student / Academic' },
  { value: 'ngo', label: 'NGO' },
  { value: 'institution', label: 'Institution Rep' },
  { value: 'govt_admin', label: 'Government Admin' },
];

export default function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('citizen');
  const [error, setError] = useState('');
  const router = useRouter();
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name, role } }, // feeds the trigger above
    });

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    router.push('/login?registered=1');
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md mx-auto mt-16 space-y-4">
      <h1 className="text-2xl font-bold">Register — Jhar Samadhan</h1>

      <input
        type="text" placeholder="Full name" value={name}
        onChange={(e) => setName(e.target.value)} required
        className="w-full border p-2 rounded"
      />
      <input
        type="email" placeholder="Email" value={email}
        onChange={(e) => setEmail(e.target.value)} required
        className="w-full border p-2 rounded"
      />
      <input
        type="password" placeholder="Password" value={password}
        onChange={(e) => setPassword(e.target.value)} required minLength={6}
        className="w-full border p-2 rounded"
      />

      <select
        value={role} onChange={(e) => setRole(e.target.value)}
        className="w-full border p-2 rounded"
      >
        {ROLES.map((r) => (
          <option key={r.value} value={r.value}>{r.label}</option>
        ))}
      </select>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      <button type="submit" className="w-full bg-blue-600 text-white p-2 rounded">
        Register
      </button>
    </form>
  );
}