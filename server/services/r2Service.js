const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

let s3Client = null;
const isR2Configured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && 
                      !R2_ACCOUNT_ID.includes('ADD_YOUR');

if (isR2Configured) {
    s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        }
    });
    console.log('✅ R2 Service initialized');
} else {
    console.warn('⚠️ R2 credentials missing or placeholders used. Media uploads will be disabled.');
}

async function generateUploadPresignedUrl(key, contentType = 'application/octet-stream') {
    if (!s3Client) throw new Error('R2 Service not configured');
    const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        ContentType: contentType
    });
    // URL expires in 15 minutes (900 seconds)
    return await getSignedUrl(s3Client, command, { expiresIn: 900 });
}

async function generateDownloadPresignedUrl(key) {
    if (!s3Client) throw new Error('R2 Service not configured');
    const command = new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
    });
    // URL expires in 1 hour (3600 seconds)
    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

async function deleteFile(key) {
    if (!s3Client) throw new Error('R2 Service not configured');
    const command = new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
    });
    return await s3Client.send(command);
}

module.exports = {
    generateUploadPresignedUrl,
    generateDownloadPresignedUrl,
    deleteFile,
    bucketName: R2_BUCKET_NAME
};
