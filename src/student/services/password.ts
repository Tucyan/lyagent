import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const READABLE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 6 || password.length > 128) {
    throw new Error("Password length must be between 6 and 128 characters");
  }
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, , , , saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return timingSafeEqual(derived, expected);
}

export function generateReadablePassword(length = 8): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += READABLE_ALPHABET[randomInt(0, READABLE_ALPHABET.length)];
  }
  return out;
}
