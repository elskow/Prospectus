type Bytes = Uint8Array<ArrayBuffer>;

function allocBytes(length: number): Bytes {
  return new Uint8Array(new ArrayBuffer(length));
}

function encryptionKey(): Bytes {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw || raw.length < 64) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be a 64-char hex string");
  }

  const key = allocBytes(32);
  key.set(Buffer.from(raw, "hex"));

  return key;
}

function toSealed(iv: Bytes, ciphertext: Bytes): string {
  return `${Buffer.from(iv).toString("base64")}.${Buffer.from(ciphertext).toString("base64")}`;
}

function fromSealed(sealed: string): { iv: Bytes; ciphertext: Bytes } {
  const [ivPart, dataPart] = sealed.split(".");
  if (!ivPart || !dataPart) throw new Error("malformed sealed payload");

  const iv = allocBytes(12);
  iv.set(Buffer.from(ivPart, "base64"));

  const ciphertext = allocBytes(Buffer.from(dataPart, "base64").length);
  ciphertext.set(Buffer.from(dataPart, "base64"));

  return { iv, ciphertext };
}

export async function seal(value: unknown): Promise<string> {
  const json = JSON.stringify(value);

  const plaintext = allocBytes(json.length);
  plaintext.set(new TextEncoder().encode(json));

  const iv = allocBytes(12);
  crypto.getRandomValues(iv);

  const key = await crypto.subtle.importKey("raw", encryptionKey(), "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, plaintext);
  const ciphertext = allocBytes(sealed.byteLength);

  ciphertext.set(new Uint8Array(sealed));

  return toSealed(iv, ciphertext);
}

export async function open<T>(sealed: string): Promise<T> {
  const { iv, ciphertext } = fromSealed(sealed);

  const key = await crypto.subtle.importKey("raw", encryptionKey(), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, ciphertext);

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
