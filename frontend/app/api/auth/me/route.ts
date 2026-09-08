import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyToken } from '@/lib/auth';

export async function GET() {
  const token = cookies().get('token')?.value;
  const user = token ? verifyToken(token) : null;

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  return NextResponse.json({ role: user.role });
}