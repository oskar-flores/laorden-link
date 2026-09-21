export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** La IP cruda no se almacena jamás (§12), solo su hash con sal. */
export async function hashIp(ip, salt) {
  return sha256Hex(`${ip}${salt}`);
}

export function newVoterId() {
  return crypto.randomUUID();
}
