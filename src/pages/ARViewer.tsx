import React, { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import { Box, Smartphone, Utensils, AlertCircle } from "lucide-react";
import { motion } from "motion/react";
import { db, handleFirestoreError, OperationType } from "../firebase";
import { doc, getDoc } from "firebase/firestore";

interface Model {
  id: string;
  name: string;
  originalName?: string;
  url: string;
  type: "file" | "link";
  restaurant?: string;
  createdAt: number;
}

const ModelViewer = "model-viewer" as any;

export default function ARViewer() {
  const { id } = useParams<{ id: string }>();
  const [model, setModel] = useState<Model | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [isModelReady, setIsModelReady] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const viewerRef = useRef<any>(null);

  useEffect(() => {
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const isUSDZ = (() => {
      if (!model?.url) return false;
      if (model.originalName?.toLowerCase().endsWith(".usdz")) return true;
      try {
        const urlObj = new URL(model.url);
        // Check if it's our proxy URL
        if (urlObj.pathname === "/api/proxy-storage") {
          const actualUrl = urlObj.searchParams.get("url");
          if (actualUrl && actualUrl.toLowerCase().split("?")[0].endsWith(".usdz")) {
            return true;
          }
        }
        return urlObj.pathname.toLowerCase().endsWith(".usdz");
      } catch {
        return model.url.toLowerCase().split("?")[0].endsWith(".usdz");
      }
    })();
    if (viewer && !isUSDZ) {
      const handleError = (event: any) => {
        console.error("Model Viewer Error Event:", event);
        if (event.detail) {
          console.error("Model Viewer Error Detail:", event.detail);
        }
        setLoadError(true);
      };
      const handleLoad = () => {
        setIsModelReady(true);
      };
      viewer.addEventListener("error", handleError);
      viewer.addEventListener("load", handleLoad);
      return () => {
        if (viewer) {
          viewer.removeEventListener("error", handleError);
          viewer.removeEventListener("load", handleLoad);
        }
      };
    } else if (isUSDZ) {
      setIsModelReady(true); // USDZ doesn't use the viewer component for loading
    }
  }, [model]);

  useEffect(() => {
    if (!id) return;

    const fetchModel = async () => {
      try {
        const docRef = doc(db, "models", id);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
          const data = docSnap.data();
          let url = data.url;
          
          // Normalize internal URLs to the current origin to avoid CORS/session issues
          if (url.includes("/api/proxy-")) {
            try {
              const urlObj = new URL(url.startsWith("http") ? url : window.location.origin + url);
              // If it's an absolute URL pointing to our own domain (or any AI Studio domain), make it relative
              const isInternal = 
                urlObj.hostname === window.location.hostname || 
                urlObj.hostname.includes("asia-southeast1.run.app") ||
                urlObj.hostname.includes("ais-dev-") ||
                urlObj.hostname.includes("ais-pre-");
                
              if (isInternal) {
                url = urlObj.pathname + urlObj.search;
              }
            } catch (e) {
              console.error("Error parsing model URL:", e);
            }
          }
          
          if (url.startsWith("/")) {
            url = `${window.location.origin}${url}`;
          }
          
          console.log("Model data fetched from Firestore:", { id: docSnap.id, ...data, url });
          setModel({ id: docSnap.id, ...data, url } as Model);
        } else {
          console.warn("Model document not found in Firestore for ID:", id);
          // Check if the ID looks like a filename (contains underscores or extensions)
          if (id.includes("_") || id.includes(".")) {
            setError(`Model not found. It looks like you're using a filename instead of a model ID. Please use the link provided in the dashboard.`);
          } else {
            setError("Model not found");
          }
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `models/${id}`);
        setError("Failed to load model data");
      } finally {
        setLoading(false);
      }
    };

    fetchModel();
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-900 text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-neutral-400 font-medium">Fetching model details...</p>
        </div>
      </div>
    );
  }

  if (error || !model) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-900 text-white p-6 text-center">
        <AlertCircle className="w-16 h-16 text-red-500 mb-4" />
        <h1 className="text-2xl font-bold mb-2">{error || "Model Not Found"}</h1>
        <p className="text-neutral-400">The 3D model you're looking for doesn't exist or has been deleted.</p>
      </div>
    );
  }

  // Determine if it's a USDZ file for iOS
  const isUSDZ = (() => {
    if (model.originalName?.toLowerCase().endsWith(".usdz")) return true;
    try {
      const urlObj = new URL(model.url);
      // Check if it's our proxy URL
      if (urlObj.pathname === "/api/proxy-storage") {
        const actualUrl = urlObj.searchParams.get("url");
        if (actualUrl && actualUrl.toLowerCase().split("?")[0].endsWith(".usdz")) {
          return true;
        }
      }
      return urlObj.pathname.toLowerCase().endsWith(".usdz");
    } catch {
      return model.url.toLowerCase().split("?")[0].endsWith(".usdz");
    }
  })();
  const isPlatformMismatch = isUSDZ && !isIOS;

  const triggerAR = () => {
    if (isPlatformMismatch) return;

    if (isUSDZ) {
      // Direct link for iOS AR Quick Look
      const anchor = document.createElement("a");
      anchor.setAttribute("rel", "ar");
      anchor.setAttribute("href", model.url);
      const img = document.createElement("img");
      anchor.appendChild(img);
      anchor.click();
    } else if (viewerRef.current) {
      viewerRef.current.activateAR();
    }
  };

  return (
    <div className="min-h-screen bg-neutral-900 flex flex-col items-center justify-center overflow-hidden p-6">
      {/* Main Content Area */}
      <div className="w-full max-w-sm space-y-12 flex flex-col items-center">
        {loadError ? (
          <div className="flex flex-col items-center gap-4 p-8 text-center bg-white/5 rounded-3xl border border-white/10 backdrop-blur-xl w-full">
            <AlertCircle className="w-12 h-12 text-red-500" />
            <p className="text-neutral-400 font-medium">Failed to load the 3D model details.</p>
            <p className="text-neutral-500 text-xs break-all max-w-xs">{model.url}</p>
            <button 
              onClick={() => window.location.reload()}
              className="px-6 py-3 bg-white/10 rounded-xl text-sm font-bold hover:bg-white/20 transition-colors"
            >
              Try Again
            </button>
          </div>
        ) : (
          <>
            {/* Visual Placeholder */}
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-56 h-56 bg-gradient-to-br from-orange-500/20 to-orange-600/5 rounded-[48px] flex items-center justify-center border border-orange-500/20 relative group"
            >
              <div className="absolute inset-0 bg-orange-500/10 blur-3xl rounded-full group-hover:bg-orange-500/20 transition-colors" />
              <Utensils className="w-24 h-24 text-orange-500 relative z-10" />
            </motion.div>

            {/* Model Info */}
            <div className="text-center space-y-3">
              <motion.div
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="flex flex-col items-center gap-1"
              >
                {model.restaurant && (
                  <span className="text-[10px] font-bold text-orange-500 uppercase tracking-[0.2em] mb-1">
                    {model.restaurant}
                  </span>
                )}
                <h2 className="text-4xl font-bold text-white tracking-tight">
                  {model.name}
                </h2>
              </motion.div>
              <motion.p 
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="text-neutral-400 text-base font-medium"
              >
                Augmented Reality Experience
              </motion.p>
            </div>

            {/* AR Trigger Button */}
            {isPlatformMismatch ? (
              <motion.div 
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="bg-red-500/10 border border-red-500/20 p-6 rounded-3xl text-center w-full"
              >
                <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
                <p className="text-red-200 font-bold mb-1">Device Mismatch</p>
                <p className="text-red-200/60 text-sm leading-relaxed">
                  This model is in <strong>.usdz</strong> format, which is only supported on iOS devices. 
                  Please use an iPhone or upload a <strong>.glb</strong> version for Android support.
                </p>
              </motion.div>
            ) : (
              <motion.button 
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.3 }}
                onClick={triggerAR}
                disabled={!isModelReady}
                className={`w-full bg-orange-500 text-white py-6 rounded-3xl font-bold shadow-2xl shadow-orange-500/40 flex items-center justify-center gap-4 active:scale-95 transition-transform text-xl ${!isModelReady ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {isModelReady ? (
                  <>
                    <Smartphone className="w-7 h-7" />
                    View in your space
                  </>
                ) : (
                  <>
                    <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    Preparing AR...
                  </>
                )}
              </motion.button>
            )}

            {/* Hidden Model Viewer for Android AR Trigger */}
            {!isUSDZ && (
              <ModelViewer
                ref={viewerRef}
                src={model.url}
                ar
                ar-modes="scene-viewer webxr quick-look"
                loading="eager"
                crossorigin="anonymous"
                style={{ 
                  position: "absolute", 
                  width: "1px", 
                  height: "1px", 
                  opacity: 0, 
                  pointerEvents: "none",
                  bottom: 0,
                  left: 0
                }}
              >
                <button slot="ar-button" id="ar-button" className="hidden" />
              </ModelViewer>
            )}
          </>
        )}
      </div>
    </div>
  );
}
