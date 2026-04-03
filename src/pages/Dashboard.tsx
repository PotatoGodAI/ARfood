import React, { useState, useEffect, useRef } from "react";
import { Upload, Link as LinkIcon, QrCode, Trash2, ExternalLink, Utensils, LogIn, LogOut, User, Edit2, Download, Check, X } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { motion, AnimatePresence } from "motion/react";
import { upload } from "@vercel/blob/client";
import { auth, db, storage, handleFirestoreError, OperationType } from "../firebase";
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "firebase/auth";
import { collection, addDoc, query, where, onSnapshot, deleteDoc, doc, orderBy, updateDoc } from "firebase/firestore";
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";

interface Model {
  id: string;
  name: string;
  originalName?: string;
  url: string;
  storagePath?: string;
  type: "file" | "link";
  size?: number;
  restaurant?: string;
  createdAt: number;
  userId: string;
}

const getPublicOrigin = () => {
  // Use environment variable if set (standard for production/Vercel)
  const envUrl = import.meta.env.VITE_APP_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  // Handle AI Studio specific domains
  if (origin.includes("ais-dev-")) {
    return origin.replace("ais-dev-", "ais-pre-");
  }
  return origin;
};

const publicOrigin = getPublicOrigin();

export default function Dashboard() {
  const [models, setModels] = useState<Model[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [driveLink, setDriveLink] = useState("");
  const [modelName, setModelName] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [selectedRestaurant, setSelectedRestaurant] = useState<string>("All");
  const [user, setUser] = useState(auth.currentUser);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setModels([]);
      return;
    }

    const q = query(
      collection(db, "models"),
      where("userId", "==", user.uid)
      // orderBy("createdAt", "desc") // Temporarily disabled to check for index issues
    );

    console.log("Setting up onSnapshot for user:", user.uid);
    const unsubscribe = onSnapshot(q, (snapshot) => {
      console.log("onSnapshot received update, count:", snapshot.docs.length);
      const modelList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Model[];
      // Sort manually since we disabled orderBy
      modelList.sort((a, b) => b.createdAt - a.createdAt);
      setModels(modelList);
    }, (error) => {
      console.error("onSnapshot error:", error);
      handleFirestoreError(error, OperationType.LIST, "models");
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      if (error.code !== "auth/cancelled-popup-request" && error.code !== "auth/popup-closed-by-user") {
        console.error("Login failed:", error);
        alert(`Login failed: ${error.message}`);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!user) return alert("Please login to upload models.");
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
      return alert("File is too large. Maximum size is 50MB.");
    }

    setUploading(true);
    setUploadProgress(0);
    
    try {
      console.log("Starting client-side Vercel Blob upload for file:", file.name, "size:", file.size);
      
      // Manual token test to get more detailed error info if it fails
      try {
        console.log("Testing token endpoint manually...");
        const tokenTest = await fetch('/api/upload/blob', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'blob.generate-token',
            payload: JSON.stringify({ userId: user.uid }),
            pathname: file.name
          })
        });
        
        if (!tokenTest.ok) {
          const errorText = await tokenTest.text();
          console.error("Token endpoint failed:", tokenTest.status, errorText);
          // We don't throw here, we let the upload() function try and fail with its own error
          // but we've logged the detailed error now.
        } else {
          console.log("Token endpoint test successful");
        }
      } catch (tokenErr) {
        console.error("Error testing token endpoint:", tokenErr);
      }
      
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/upload/blob',
        clientPayload: JSON.stringify({ userId: user.uid }),
        onUploadProgress: (progressEvent) => {
          const progress = Math.round(progressEvent.percentage);
          setUploadProgress(progress);
          console.log("Upload progress:", progress, "%");
        },
      }).catch(err => {
        console.error("Vercel Blob upload function error:", err);
        throw err;
      });

      console.log("Upload successful, blob response:", blob);
      
      // Use our proxy to avoid CORS issues on the client
      const proxiedUrl = `/api/proxy-storage?url=${encodeURIComponent(blob.url)}`;
      
      const modelData = {
        name: file.name.replace(/\.[^/.]+$/, ""), // Remove extension
        originalName: file.name,
        url: proxiedUrl,
        storagePath: blob.url,
        type: "file",
        size: file.size,
        restaurant: restaurantName || "General",
        createdAt: Date.now(),
        userId: user.uid,
      };
      
      console.log("Adding document to Firestore:", modelData);
      const docRef = await addDoc(collection(db, "models"), modelData);
      console.log("Document added successfully with ID:", docRef.id);
      setUploading(false);
      setUploadProgress(0);
      setRestaurantName("");
    } catch (error: any) {
      console.error("Upload error:", error);
      alert(`Upload failed: ${error.message}`);
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return alert("Please login to add links.");
    if (!driveLink || !modelName) return;

    let directUrl = driveLink;
    if (driveLink.includes("drive.google.com")) {
      const fileIdMatch = driveLink.match(/\/d\/(.+?)\//) || driveLink.match(/id=(.+?)(&|$)/);
      if (fileIdMatch) {
        // Try to detect extension from the link or name
        const isUSDZ = driveLink.toLowerCase().includes(".usdz") || modelName.toLowerCase().endsWith(".usdz");
        const ext = isUSDZ ? ".usdz" : ".glb";
        const safeName = modelName.toLowerCase().replace(/\s+/g, "-").replace(/\.(glb|usdz|gltf)$/, "");
        // Use a relative URL for the internal data
        directUrl = `/api/proxy-drive/${fileIdMatch[1]}/${safeName}${ext}`;
      }
    }

    try {
      // NOTE: Firestore stores the model metadata, while Vercel Blob or External Links store the actual file.
      const modelData = {
        name: modelName,
        url: directUrl,
        type: "link",
        restaurant: restaurantName || "General",
        createdAt: Date.now(),
        userId: user.uid,
      };
      await addDoc(collection(db, "models"), modelData);
      setDriveLink("");
      setModelName("");
      setRestaurantName("");
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, "models");
    }
  };

  const deleteModel = async (id: string) => {
    const model = models.find(m => m.id === id);
    if (!model) return;

    // Redundant confirm removed as we have a custom UI now
    // if (!window.confirm(`Are you sure you want to delete "${model.name}"?`)) return;

    setDeletingId(id);
    try {
      // If it's a file upload, delete from storage first
      if (model.storagePath) {
        try {
          if (model.storagePath.includes("vercel-storage.com")) {
            // Delete from Vercel Blob via our server
            await fetch("/api/blob/delete", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: model.storagePath })
            });
            console.log("File deleted from Vercel Blob");
          } else {
            // Legacy Firebase Storage deletion
            const storageRef = ref(storage, model.storagePath);
            await deleteObject(storageRef);
            console.log("File deleted from Firebase Storage");
          }
        } catch (error) {
          console.error("Error deleting file from storage:", error);
        }
      } else if (model.type === "file" && model.url.includes("/uploads/")) {
        // Handle legacy server-side uploads
        const filename = model.url.split("/").pop()?.split("?")[0];
        if (filename) {
          try {
            await fetch(`/api/files/${filename}`, { method: "DELETE" });
            console.log("File deleted from server");
          } catch (error) {
            console.error("Error deleting from server:", error);
          }
        }
      }
      
      await deleteDoc(doc(db, "models", id));
      setDeletingId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `models/${id}`);
      alert("Failed to delete model. Please try again.");
      setDeletingId(null);
    }
  };

  const startEditing = (model: Model) => {
    setEditingId(model.id);
    setEditName(model.name);
  };

  const saveName = async () => {
    if (!editingId || !editName.trim()) return;
    try {
      await updateDoc(doc(db, "models", editingId), {
        name: editName.trim()
      });
      setEditingId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `models/${editingId}`);
    }
  };

  const downloadQR = (modelId: string, modelName: string) => {
    const canvas = document.getElementById(`qr-${modelId}`) as HTMLCanvasElement;
    if (!canvas) return;
    
    const url = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = url;
    link.download = `qr-${modelName.toLowerCase().replace(/\s+/g, "-")}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return "Unknown size";
    const mb = bytes / (1024 * 1024);
    return mb < 1 ? `${(bytes / 1024).toFixed(1)} KB` : `${mb.toFixed(2)} MB`;
  };

  const restaurants = ["All", ...Array.from(new Set(models.map(m => m.restaurant || "General")))];
  const filteredModels = selectedRestaurant === "All" 
    ? models 
    : models.filter(m => (m.restaurant || "General") === selectedRestaurant);

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col lg:flex-row">
      {/* Sidebar for Desktop */}
      <aside className="w-full lg:w-80 bg-white border-b lg:border-b-0 lg:border-r border-neutral-200 p-6 lg:h-screen lg:sticky lg:top-0 overflow-y-auto shrink-0">
        <div className="flex items-center gap-3 mb-10">
          <div className="p-2.5 bg-orange-500 rounded-xl shadow-lg shadow-orange-200">
            <Utensils className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-neutral-900">FoodAR</h1>
            <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">Chef Dashboard</p>
          </div>
        </div>

        {user ? (
          <div className="space-y-8">
            <div className="bg-neutral-50 p-4 rounded-2xl border border-neutral-100">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center text-orange-600">
                  <User className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold truncate">{user.displayName}</p>
                  <p className="text-[10px] text-neutral-500 uppercase tracking-wider">Verified Chef</p>
                </div>
              </div>
              <button 
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-white border border-neutral-200 rounded-xl text-xs font-bold text-neutral-600 hover:bg-red-50 hover:text-red-600 hover:border-red-100 transition-all"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>

            <div className="space-y-4">
              <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-widest px-2">Restaurants</h3>
              <div className="space-y-1">
                {restaurants.map(r => (
                  <button
                    key={r}
                    onClick={() => setSelectedRestaurant(r)}
                    className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-between ${
                      selectedRestaurant === r 
                        ? 'bg-orange-500 text-white shadow-lg shadow-orange-200' 
                        : 'text-neutral-600 hover:bg-neutral-50'
                    }`}
                  >
                    {r}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-md ${
                      selectedRestaurant === r ? 'bg-white/20 text-white' : 'bg-neutral-100 text-neutral-400'
                    }`}>
                      {r === "All" ? models.length : models.filter(m => (m.restaurant || "General") === r).length}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-4 border-t border-neutral-100">
              <div className="bg-blue-50 p-4 rounded-2xl border border-blue-100">
                <p className="text-[10px] font-bold text-blue-600 uppercase tracking-widest mb-2">Storage Tip</p>
                <p className="text-[11px] text-blue-800 leading-relaxed">
                  Use <strong>.glb</strong> for universal support. <strong>.usdz</strong> is iOS only.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-neutral-500 leading-relaxed">Login to start managing your 3D food models and AR menus.</p>
            <button 
              onClick={handleLogin}
              disabled={isLoggingIn}
              className="w-full flex items-center justify-center gap-3 bg-neutral-900 text-white py-4 rounded-2xl font-bold hover:bg-neutral-800 transition-all shadow-xl shadow-neutral-200"
            >
              {isLoggingIn ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                <LogIn className="w-5 h-5" />
              )}
              Google Login
            </button>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-6 lg:p-12 overflow-x-hidden">
        <div className="max-w-6xl mx-auto space-y-12">
          {/* Top Bar / Upload Section */}
          <div className="grid md:grid-cols-2 gap-8">
            <div className={`bg-white p-6 rounded-[32px] border border-neutral-200 shadow-sm transition-opacity ${!user ? 'opacity-50 pointer-events-none' : ''}`}>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold flex items-center gap-3">
                  <div className="p-2 bg-orange-100 rounded-lg">
                    <Upload className="w-5 h-5 text-orange-600" />
                  </div>
                  Quick Upload
                </h2>
                <input 
                  type="text"
                  placeholder="Restaurant Name"
                  value={restaurantName}
                  onChange={(e) => setRestaurantName(e.target.value)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-neutral-200 focus:border-orange-500 outline-none w-32"
                />
              </div>
              
              <label className="group relative flex flex-col items-center justify-center w-full h-40 border-2 border-dashed border-neutral-200 rounded-3xl cursor-pointer hover:border-orange-400 hover:bg-orange-50/30 transition-all">
                <div className="flex flex-col items-center justify-center">
                  <Upload className="w-6 h-6 text-neutral-400 group-hover:text-orange-600 mb-2 transition-colors" />
                  <p className="text-xs font-bold text-neutral-500">Drop GLB/USDZ here</p>
                </div>
                <input type="file" className="hidden" accept=".glb,.usdz,.gltf" onChange={handleFileUpload} disabled={uploading} />
                {uploading && (
                  <div className="absolute inset-0 bg-white/95 backdrop-blur-sm rounded-3xl flex items-center justify-center z-20 p-6">
                    <div className="w-full space-y-2">
                      <div className="flex justify-between text-[10px] font-bold text-orange-600 uppercase">
                        <span>Uploading...</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-orange-100 rounded-full overflow-hidden">
                        <motion.div className="h-full bg-orange-500" initial={{ width: 0 }} animate={{ width: `${uploadProgress}%` }} />
                      </div>
                    </div>
                  </div>
                )}
              </label>
            </div>

            <div className={`bg-white p-6 rounded-[32px] border border-neutral-200 shadow-sm transition-opacity ${!user ? 'opacity-50 pointer-events-none' : ''}`}>
              <h2 className="text-lg font-bold mb-6 flex items-center gap-3">
                <div className="p-2 bg-orange-100 rounded-lg">
                  <LinkIcon className="w-5 h-5 text-orange-600" />
                </div>
                External Link
              </h2>
              <form onSubmit={handleLinkSubmit} className="grid grid-cols-2 gap-3">
                <input 
                  type="text" 
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="Model Name"
                  className="col-span-2 px-4 py-2.5 rounded-xl border border-neutral-200 text-sm outline-none focus:border-orange-500 bg-neutral-50/50"
                />
                <input 
                  type="url" 
                  value={driveLink}
                  onChange={(e) => setDriveLink(e.target.value)}
                  placeholder="Google Drive URL"
                  className="col-span-2 px-4 py-2.5 rounded-xl border border-neutral-200 text-sm outline-none focus:border-orange-500 bg-neutral-50/50"
                />
                <button type="submit" className="col-span-2 bg-neutral-900 text-white py-3 rounded-xl font-bold text-sm hover:bg-neutral-800 transition-all">
                  Add Link
                </button>
              </form>
            </div>
          </div>

          {/* Models Grid */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold text-neutral-900">
                {selectedRestaurant === "All" ? "All Models" : `${selectedRestaurant} Menu`}
              </h2>
              <div className="flex items-center gap-2 text-xs font-bold text-neutral-400">
                <Check className="w-4 h-4 text-green-500" />
                {filteredModels.length} Items Found
              </div>
            </div>

            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-6">
              <AnimatePresence mode="popLayout">
                {filteredModels.map((model) => (
                  <motion.div 
                    key={model.id}
                    layout
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="bg-white rounded-[32px] border border-neutral-200 shadow-sm overflow-hidden group hover:border-orange-200 transition-all flex flex-col"
                  >
                    <div className="p-6 flex-1 space-y-4">
                      <div className="flex items-start justify-between">
                        <div className="p-3 bg-neutral-50 rounded-2xl relative group/qr shrink-0">
                          <QRCodeCanvas id={`qr-${model.id}`} value={`${publicOrigin}/ar/${model.id}`} size={80} level="H" />
                          <button 
                            onClick={() => downloadQR(model.id, model.name)}
                            className="absolute inset-0 bg-orange-500/90 backdrop-blur-sm rounded-2xl opacity-0 group-hover/qr:opacity-100 transition-opacity flex items-center justify-center text-white"
                          >
                            <Download className="w-5 h-5" />
                          </button>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <span className="text-[10px] font-bold px-2 py-1 bg-orange-100 text-orange-600 rounded-lg uppercase tracking-wider">
                            {model.restaurant || "General"}
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-1 rounded-lg uppercase tracking-wider ${
                            model.url.toLowerCase().endsWith('.usdz') ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'
                          }`}>
                            {model.url.toLowerCase().endsWith('.usdz') ? 'iOS' : 'Universal'}
                          </span>
                        </div>
                      </div>

                      <div className="space-y-1">
                        {editingId === model.id ? (
                          <div className="flex items-center gap-2">
                            <input 
                              autoFocus
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && saveName()}
                              className="flex-1 text-lg font-bold border-b-2 border-orange-500 outline-none bg-transparent"
                            />
                            <button onClick={saveName} className="text-green-600"><Check className="w-5 h-5" /></button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between group/title">
                            <h3 className="font-bold text-lg truncate pr-2">{model.name}</h3>
                            <button onClick={() => startEditing(model)} className="opacity-0 group-hover/title:opacity-100 text-neutral-400 hover:text-orange-500"><Edit2 className="w-4 h-4" /></button>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-[10px] font-bold text-neutral-400 uppercase tracking-widest">
                          <span>{new Date(model.createdAt).toLocaleDateString()}</span>
                          <span className="text-neutral-500">{formatSize(model.size)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="p-4 bg-neutral-50 border-t border-neutral-100 flex items-center gap-2">
                      <a 
                        href={`/ar/${model.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 bg-neutral-900 text-white text-xs font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:bg-orange-500 transition-all"
                      >
                        <ExternalLink className="w-4 h-4" />
                        AR Preview
                      </a>
                      <button 
                        onClick={() => {
                          navigator.clipboard.writeText(`${publicOrigin}/ar/${model.id}`);
                          alert("Link copied!");
                        }}
                        className="p-3 bg-white border border-neutral-200 text-neutral-600 rounded-xl hover:text-orange-600 hover:border-orange-200 transition-all"
                      >
                        <LinkIcon className="w-4 h-4" />
                      </button>
                      <div className="relative">
                        {deletingId === model.id ? (
                          <div className="absolute right-0 bottom-0 flex items-center gap-1 bg-white p-1 rounded-xl shadow-xl border border-red-100 z-10">
                            <button onClick={() => deleteModel(model.id)} className="px-3 py-2 bg-red-600 text-white text-[10px] font-bold rounded-lg">Delete</button>
                            <button onClick={() => setDeletingId(null)} className="p-2 text-neutral-400"><X className="w-4 h-4" /></button>
                          </div>
                        ) : (
                          <button onClick={() => setDeletingId(model.id)} className="p-3 bg-white border border-neutral-200 text-neutral-400 hover:text-red-600 hover:border-red-100 rounded-xl transition-all">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {filteredModels.length === 0 && (
                <div className="col-span-full py-20 text-center bg-neutral-100/50 rounded-[40px] border-2 border-dashed border-neutral-200">
                  <Utensils className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
                  <p className="text-neutral-500 font-bold">No models found for this category</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
