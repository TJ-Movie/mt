import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const execute = process.argv.includes('--execute');
const dryRun = process.argv.includes('--dry-run');
if (execute && dryRun) throw new Error('Choose either --execute or --dry-run');
if (!execute && !dryRun) throw new Error('Refusing destructive multipart cleanup without --execute (or --dry-run)');

const account = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET_NAME;
if (!account || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  throw new Error('R2 credentials and R2_BUCKET_NAME are required');
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${account}.r2.cloudflarestorage.com`,
  maxAttempts: 3,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function listUploads() {
  const uploads = [];
  let keyMarker;
  let uploadIdMarker;
  do {
    const page = await s3.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      KeyMarker: keyMarker,
      UploadIdMarker: uploadIdMarker,
    }));
    uploads.push(...(page.Uploads || []).filter((upload) => upload.Key && upload.UploadId));
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker !== undefined || uploadIdMarker !== undefined);
  return uploads;
}

async function estimateParts(upload) {
  let marker;
  let bytes = 0;
  do {
    const page = await s3.send(new ListPartsCommand({
      Bucket: bucket,
      Key: upload.Key,
      UploadId: upload.UploadId,
      PartNumberMarker: marker,
    }));
    for (const part of page.Parts || []) bytes += part.Size || 0;
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker !== undefined);
  return bytes;
}

async function main() {
  try {
    const uploads = await listUploads();
    let estimatedBytes = 0;
    for (const upload of uploads) {
      estimatedBytes += await estimateParts(upload);
    }

    let aborted = 0;
    if (!execute) {
      console.log(`Dry run: found ${uploads.length} incomplete multipart upload(s).`);
      console.log(`Estimated hidden storage: ${(estimatedBytes / 1_000_000_000).toFixed(2)} GB.`);
      return;
    }
    for (const upload of uploads) {
      await s3.send(new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }));
      aborted += 1;
    }

    const remaining = await listUploads();
    if (remaining.length) throw new Error(`Verification failed: ${remaining.length} multipart upload(s) remain`);
    console.log(`Aborted ${aborted} incomplete multipart upload(s).`);
    console.log(`Reclaimed estimated hidden storage: ${(estimatedBytes / 1_000_000_000).toFixed(2)} GB.`);
    console.log(JSON.stringify({ event: 'r2-multipart-abort', aborted, estimatedBytes, remaining: remaining.length }));
  } finally {
    s3.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
