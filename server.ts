import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import cors from "cors";
import fs from "fs";
import { Readable } from "stream";
import { put, del } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";

import admin from "firebase-admin";

// Load Firebase config from file or environment variables
let firebaseConfig: any = {};
try {
  const configPath = path.resolve(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } else {
    // Fallback to environment variables for Vercel/Production
    firebaseConfig = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      appId: process.env.FIREBASE_APP_ID,
    };
    console.log("Using environment variables for Firebase config");
  }
} catch (error) {
  console.error("Error reading Firebase config:", error);
}

// Initialize Admin SDK for server-side persistence
if (!admin.apps.length) {
  console.log("Initializing Firebase Admin with Project ID:", firebaseConfig.projectId);
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
    storageBucket: firebaseConfig.storageBucket
  });
}

import os from "os";

const app = express();

// Basic middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Request logging to help debug 404s on shared URLs
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    // Only log API requests, uploads, or errors to reduce noise
    const isApiRequest = req.url.startsWith("/api") || req.url.startsWith("/uploads");
    const isError = res.statusCode >= 400;
    
    if (isApiRequest || isError) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Status: ${res.statusCode} - ${duration}ms - Host: ${req.headers.host}`);
    }
  });
  next();
});

// Use /tmp for Vercel compatibility (only writable directory)
const uploadsDir = process.env.VERCEL ? "/tmp" : path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir) && !process.env.VERCEL) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({ 
  storage: multerStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedExtensions = [".glb", ".usdz", ".gltf"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .glb, .usdz, and .gltf files are allowed"));
    }
  }
});

// API Routes
// Vercel Blob client-side upload authorization
app.post("/api/upload/blob", async (req, res) => {
  const body = req.body;
  console.log(`[Vercel Blob] Received token request for: ${body?.pathname || 'unknown'}`);
  
  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      console.error("[Vercel Blob] BLOB_READ_WRITE_TOKEN is missing in environment");
      return res.status(500).json({ error: "Storage token not configured on server" });
    }

    const jsonResponse = await handleUpload({
      body,
      request: req,
      token: blobToken,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = JSON.parse(clientPayload || '{}');
        if (!payload.userId) {
          throw new Error("User ID is required for upload");
        }
        
        console.log(`[Vercel Blob] Generating token for user: ${payload.userId}, path: ${pathname}`);
        
        return {
          allowedContentTypes: [
            "model/gltf-binary", 
            "model/vnd.usdz+zip", 
            "application/octet-stream",
            "model/gltf+json"
          ],
          tokenPayload: JSON.stringify({
            userId: payload.userId,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log("Vercel Blob upload completed:", blob.url, "for user:", tokenPayload);
      },
    });
    
    return res.status(200).json(jsonResponse);
  } catch (error: any) {
    console.error("Vercel Blob handleUpload error:", error);
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/upload", upload.single("model"), async (req, res) => {
  console.log(`[${new Date().toISOString()}] POST /api/upload - Received file:`, req.file?.originalname);
  
  if (!req.file) {
    console.error("Upload Error: No file provided in request");
    return res.status(400).json({ error: "No file uploaded" });
  }
  
  try {
    console.log("File uploaded to server buffer, now persisting to Vercel Blob:", req.file.originalname);
    
    // Use the provided token for Vercel Blob
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      throw new Error("BLOB_READ_WRITE_TOKEN is not configured in Vercel environment variables");
    }
    
    const blob = await put(`models/${req.body.userId || 'anonymous'}/${Date.now()}_${req.file.originalname}`, fs.readFileSync(req.file.path), {
      access: 'public',
      token: blobToken,
      contentType: req.file.mimetype
    });
    
    console.log("File persisted to Vercel Blob successfully:", blob.url);
    
    // Clean up the temporary local file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.json({ 
      url: blob.url, 
      filename: req.file.originalname,
      storagePath: blob.url // Use URL as storagePath for Vercel Blob
    });
  } catch (error: any) {
    console.error("Error persisting to Vercel Blob:", error);
    
    res.status(500).json({ 
      error: `Failed to persist file: ${error.message}`,
      details: error.code || "Unknown storage error"
    });
  }
});

app.delete("/api/blob/delete", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL" });
  
  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      throw new Error("BLOB_READ_WRITE_TOKEN is not configured in Vercel environment variables");
    }
    await del(url, { token: blobToken });
    res.json({ message: "Blob deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting from Vercel Blob:", error);
    res.status(500).json({ error: `Failed to delete blob: ${error.message}` });
  }
});

app.delete("/api/files/:filename", (req, res) => {
  const filename = req.params.filename;
  // Basic security check to prevent path traversal
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  
  const filePath = path.join(uploadsDir, filename);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      res.json({ message: "File deleted successfully" });
    } catch (error) {
      console.error("Error deleting file:", error);
      res.status(500).json({ error: "Failed to delete file" });
    }
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

app.get("/api/proxy-storage", async (req, res) => {
  const storageUrl = req.query.url as string;
  if (!storageUrl) return res.status(400).send("Missing URL");
  
  console.log(`[Proxy] Fetching storage file: ${storageUrl}`);
  
  try {
    const response = await fetch(storageUrl);
    if (!response.ok) {
      console.error(`[Proxy] Failed to fetch from Storage: ${response.status} ${response.statusText}`);
      throw new Error(`Failed to fetch from Storage: ${response.status}`);
    }
    
    let contentType = response.headers.get("content-type");
    // Fallback content types based on extension if missing or generic
    if (!contentType || contentType === "application/octet-stream") {
      const lowerUrl = storageUrl.toLowerCase();
      if (lowerUrl.includes(".glb")) contentType = "model/gltf-binary";
      else if (lowerUrl.includes(".usdz")) contentType = "model/vnd.usdz+zip";
    }
    
    if (contentType) {
      console.log(`[Proxy] Setting Content-Type: ${contentType}`);
      res.setHeader("Content-Type", contentType);
    }
    
    const contentLength = response.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    
    // Allow CORS for the proxied file
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");
    
    const body = response.body;
    if (body) {
      // @ts-ignore
      Readable.fromWeb(body).pipe(res);
    } else {
      console.warn("[Proxy] Empty body received from storage");
      res.end();
    }
  } catch (error: any) {
    console.error("[Proxy] Storage proxy error:", error);
    res.status(500).send(`Error proxying storage file: ${error.message}`);
  }
});

// Proxy for Google Drive files to ensure direct access for AR viewers
app.get("/api/proxy-drive/:id/:filename?", async (req, res) => {
  const fileId = req.params.id;
  let driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  
  console.log(`[Proxy-Drive] Fetching file ID: ${fileId}`);
  
  try {
    // First attempt to fetch
    let response = await fetch(driveUrl);
    
    // Check if we hit the virus scan warning page
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
      const html = await response.text();
      // Look for the confirmation token in the HTML
      const confirmMatch = html.match(/confirm=([a-zA-Z0-9_-]+)/);
      if (confirmMatch) {
        const confirmToken = confirmMatch[1];
        driveUrl = `${driveUrl}&confirm=${confirmToken}`;
        console.log(`[Proxy-Drive] Confirming virus scan with token: ${confirmToken}`);
        response = await fetch(driveUrl);
      }
    }

    if (!response.ok) {
      console.error(`[Proxy-Drive] Failed to fetch from Google Drive: ${response.status}`);
      throw new Error(`Failed to fetch from Google Drive: ${response.status}`);
    }
    
    // Forward headers
    let resContentType = response.headers.get("content-type");
    const filename = req.params.filename?.toLowerCase() || "";
    if (filename.endsWith(".glb")) {
      resContentType = "model/gltf-binary";
    } else if (filename.endsWith(".usdz")) {
      resContentType = "model/vnd.usdz+zip";
    }
    
    if (resContentType) {
      console.log(`[Proxy-Drive] Setting Content-Type: ${resContentType}`);
      res.setHeader("Content-Type", resContentType);
    }
    
    // Forward content length if available
    const contentLength = response.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    // Allow CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");

    // Stream the response
    const body = response.body;
    if (body) {
      // @ts-ignore
      Readable.fromWeb(body).pipe(res);
    } else {
      console.warn("[Proxy-Drive] Empty body received from Drive");
      res.end();
    }
  } catch (error: any) {
    console.error("[Proxy-Drive] Proxy error:", error);
    res.status(500).send(`Error proxying file: ${error.message}`);
  }
});

// Serve uploads statically with custom MIME types
app.use("/uploads", express.static(uploadsDir, {
  setHeaders: (res, path) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (path.endsWith(".glb")) {
      res.setHeader("Content-Type", "model/gltf-binary");
    } else if (path.endsWith(".usdz")) {
      res.setHeader("Content-Type", "model/vnd.usdz+zip");
    }
  }
}));

// Global error handler for multer and other errors
app.use((err: any, req: any, res: any, next: any) => {
  if (err instanceof multer.MulterError) {
    console.error("Multer Error:", err);
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Max 50MB." });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    console.error("Server Error:", err);
    return res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  }
  next();
});

async function startServer() {
  const PORT = 3000;

  // Vite middleware for development OR if build is missing in production
  const isProd = process.env.NODE_ENV === "production";
  const distPath = path.join(process.cwd(), "dist");
  const distIndex = path.join(distPath, "index.html");
  const rootIndex = path.join(process.cwd(), "index.html");

  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    console.log(`[Server] Running in development mode, using Vite middleware`);
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);

    // Explicit fallback for SPA routes
    app.get("*", async (req, res, next) => {
      // Only handle GET requests for the SPA fallback
      if (req.method !== "GET") return next();
      
      const url = req.originalUrl;
      // Skip API, uploads, and source files
      if (
        url.startsWith("/api") || 
        url.startsWith("/uploads") || 
        url.startsWith("/src") || 
        url.startsWith("/node_modules") ||
        (url.includes(".") && !url.endsWith(".html")) // Skip files with extensions except .html
      ) {
        return next();
      }
      try {
        let template = fs.readFileSync(rootIndex, "utf-8");
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e) {
        next(e);
      }
    });
  } else if (isProd && fs.existsSync(distIndex)) {
    console.log("[Server] Running in production mode, serving from dist/");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(distIndex);
    });
  } else if (isProd) {
    // Fallback for production if dist is missing (e.g. during first run or in some cloud environments)
    app.get("*", (req, res) => {
      if (fs.existsSync(rootIndex)) {
        res.sendFile(rootIndex);
      } else {
        res.status(404).send("Application index.html not found");
      }
    });
  }

  // Only listen if not running as a serverless function (e.g. on Vercel)
  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
}

startServer();

export default app;
