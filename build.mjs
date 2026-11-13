import { build } from 'esbuild';
await build({ entryPoints: ['auth-entry.js'], bundle: true, minify: true, format: 'iife', outfile: 'public/auth.bundle.js', platform: 'browser' });
console.log('auth bundle ok');
