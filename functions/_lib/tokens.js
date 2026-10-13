// Chiffrement des jetons de rafraîchissement Spotify (spécification, section 6.3) : AES-GCM,
// clé TOKEN_ENC_KEY (32 octets en base64), partagée avec le traitement (src/library/spotify.py).
//
// Format : « v1.<iv>.<chiffré> » (base64url ; le chiffré inclut l'étiquette de 16 octets).
// L'identifiant du membre est lié au chiffré (données associées) : un jeton recopié sur la
// ligne d'un autre membre ne se déchiffre pas.

const b64urlEncode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64Decode = (text) => {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

export function tokenKeyReady(env) {
  try { return b64Decode(env.TOKEN_ENC_KEY || "").length === 32; } catch { return false; }
}

async function importKey(env) {
  let raw;
  try { raw = b64Decode(env.TOKEN_ENC_KEY || ""); } catch { raw = new Uint8Array(); }
  if (raw.length !== 32) throw new Error("TOKEN_ENC_KEY absente ou invalide (32 octets en base64 attendus)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(env, userId, token) {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) }, key, new TextEncoder().encode(token));
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(sealed))}`;
}

export async function decryptToken(env, userId, value) {
  const [version, iv, sealed] = String(value || "").split(".");
  if (version !== "v1" || !iv || !sealed) throw new Error("jeton chiffré illisible");
  const key = await importKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64Decode(iv), additionalData: new TextEncoder().encode(userId) }, key, b64Decode(sealed));
  return new TextDecoder().decode(plain);
}
