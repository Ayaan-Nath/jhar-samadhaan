import { NextResponse } from 'next/server';
import { getDbPool } from '@/lib/db';
import { hashPassword } from '@/lib/auth';

export async function POST(req: Request) {
  const { name, email, password, role } = await req.json();

  if (!name || !email || !password || !role) {
    return NextResponse.json({ error: 'All fields are required' }, { status: 400 });
  }

  const pool = getDbPool();
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, role`,
    [name, email, passwordHash, role]
  );

  return NextResponse.json({ user: result.rows[0] }, { status: 201 });
}