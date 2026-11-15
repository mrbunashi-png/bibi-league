import { getUser, oauthLogin, handleAuthCallback, logout, refreshSession, hydrateSession } from '@netlify/identity';
window.BibiAuth = { getUser, oauthLogin, handleAuthCallback, logout, refreshSession, hydrateSession };
