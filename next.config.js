/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['onnxruntime-node'],
}

module.exports = nextConfig
