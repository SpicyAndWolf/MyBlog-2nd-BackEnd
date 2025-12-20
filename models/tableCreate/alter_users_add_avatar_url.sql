-- If your users table already exists, run this once:
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
