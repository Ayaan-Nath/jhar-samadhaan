'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabaseClient';

const ROLE_NAV: Record<string, { label: string; href: string }> = {
  citizen: { label: 'Submit a Complaint', href: '/citizen/submit' },
  student: { label: 'Academic Opportunities', href: '/academic/opportunities' },
  institution: { label: 'Academic Opportunities', href: '/academic/opportunities' },
  ngo: { label: 'Industry & CSR Marketplace', href: '/industry/marketplace' },
  govt_admin: { label: 'Admin Dashboard', href: '/admin/complaints' },
};

export default function Navbar() {
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const loadRole = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setLoading(false);
        return;
      }
      const { data: profile } = await supabase
        .from('users')
        .select('role')
        .eq('auth_id', session.user.id)
        .single();
      setRole(profile?.role ?? null);
      setLoading(false);
    };
    loadRole();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  const nav = role ? ROLE_NAV[role] : null;

  return (
    <nav className="flex items-center justify-between px-6 py-3 border-b">
      <Link href="/" className="font-bold">Jhar Samadhan</Link>

      <div className="flex items-center gap-4">
        {!loading && nav && (
          <Link href={nav.href} className="text-sm hover:underline">
            {nav.label}
          </Link>
        )}
        {!loading && role && (
          <button onClick={handleLogout} className="text-sm text-red-600">
            Logout
          </button>
        )}
        {!loading && !role && (
          <>
            <Link href="/login" className="text-sm hover:underline">Login</Link>
            <Link href="/register" className="text-sm hover:underline">Register</Link>
          </>
        )}
      </div>
    </nav>
  );
}