import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Object storage for session transcripts. Keys are bucket-relative ("sessions/acct_1/...").
 *  - TRANSCRIPTS_S3_BUCKET set -> S3-compatible store (MinIO in the local stack, or S3/R2/GCS)
 *  - otherwise                 -> files under TRANSCRIPTS_DIR (default .transcripts/)
 */
export interface ObjectStore {
  kind: "s3" | "fs";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(keys: string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Short-lived download URL, or null when the backend can't produce one. */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string | null>;
}

async function createS3Store(bucket: string): Promise<ObjectStore> {
  const s3 = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = new s3.S3Client({
    region: process.env.TRANSCRIPTS_S3_REGION ?? "us-east-1",
    endpoint: process.env.TRANSCRIPTS_S3_ENDPOINT,
    forcePathStyle: Boolean(process.env.TRANSCRIPTS_S3_ENDPOINT), // MinIO / custom endpoints
    credentials: process.env.TRANSCRIPTS_S3_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.TRANSCRIPTS_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.TRANSCRIPTS_S3_SECRET_ACCESS_KEY ?? "",
        }
      : undefined, // fall back to the default AWS credential chain
  });
  const store: ObjectStore = {
    kind: "s3",
    async put(key, body, contentType) {
      await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const res = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        if (chunk.length)
          await client.send(new s3.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })) } }));
      }
    },
    async deletePrefix(prefix) {
      let token: string | undefined;
      do {
        const page = await client.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        await store.delete((page.Contents ?? []).map((o) => o.Key!).filter(Boolean));
        token = page.NextContinuationToken;
      } while (token);
    },
    signedUrl(key, expiresIn = 900) {
      return getSignedUrl(client, new s3.GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
    },
  };
  return store;
}

function createFsStore(root: string): ObjectStore {
  const resolve = (key: string) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error(`Invalid object key: ${key}`);
    return full;
  };
  return {
    kind: "fs",
    async put(key, body) {
      const file = resolve(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
    },
    get: (key) => readFile(resolve(key)),
    async delete(keys) {
      await Promise.all(keys.map((k) => rm(resolve(k), { force: true })));
    },
    async deletePrefix(prefix) {
      await rm(resolve(prefix), { recursive: true, force: true });
    },
    signedUrl: async () => null,
  };
}

let storePromise: Promise<ObjectStore> | undefined;

export function getStore(): Promise<ObjectStore> {
  const bucket = process.env.TRANSCRIPTS_S3_BUCKET;
  const root =
    process.env.TRANSCRIPTS_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".transcripts");
  storePromise ??= bucket ? createS3Store(bucket) : Promise.resolve(createFsStore(root));
  return storePromise;
}
