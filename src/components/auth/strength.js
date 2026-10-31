// Lightweight passphrase strength estimate (no dependency). Not a substitute for zxcvbn,
// but it penalises the usual weak patterns and rewards length, which is what matters most
// for a PBKDF2-protected vault.

const COMMON = [
  'password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon',
  'abc123', '123456', '12345678', 'codehub', 'discord', 'secret', 'football', 'baseball', 'sunshine',
];

export const MIN_PASSPHRASE = 10;

export function passphraseStrength(pw = '') {
  if (!pw) return { score: 0, label: '', hint: `At least ${MIN_PASSPHRASE} characters. A few random words works great.` };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9\s]/.test(pw)) pool += 33;
  if (/\s/.test(pw)) pool += 1;
  const unique = new Set(pw).size;
  let bits = pw.length * Math.log2(Math.max(pool, 2));
  // Penalise low variety and repetition.
  if (unique < pw.length / 2) bits *= 0.6;
  if (/(.)\1{2,}/.test(pw)) bits *= 0.8;
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf|zxcv)/i.test(pw)) bits *= 0.75;
  const lower = pw.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) bits *= 0.5;
  const words = pw.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3);
  if (words.length >= 4) bits = Math.max(bits, 55); // diceware-style passphrases

  let score;
  if (pw.length < MIN_PASSPHRASE || bits < 35) score = 1;
  else if (bits < 50) score = 2;
  else if (bits < 70) score = 3;
  else score = 4;

  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  let hint;
  if (pw.length < MIN_PASSPHRASE) hint = `${MIN_PASSPHRASE - pw.length} more character${MIN_PASSPHRASE - pw.length === 1 ? '' : 's'} needed.`;
  else if (score === 1) hint = 'Too predictable. Try several unrelated words.';
  else if (score === 2) hint = 'Okay, but longer is much better. Add another word.';
  else if (score === 3) hint = 'Good. One more word would make it excellent.';
  else hint = 'Excellent passphrase.';
  return { score, label: labels[score], hint, bits: Math.round(bits) };
}
