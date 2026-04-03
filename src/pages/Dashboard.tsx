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
        createdAt: Date.now(),
        userId: user.uid,
      };
      
      console.log("Adding document to Firestore:", modelData);
      const docRef = await addDoc(collection(db, "models"), modelData);
      console.log("Document added successfully with ID:", docRef.id);
      setUploading(false);
      setUploadProgress(0);
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
        createdAt: Date.now(),
        userId: user.uid,
      };
      await addDoc(collection(db, "models"), modelData);
      setDriveLink("");
      setModelName("");
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

  return (
    <div className="max-w-5xl mx-auto p-6 md:p-12">
      {/* Shared URL Warning */}
      {window.location.origin.includes("ais-dev-") && (
        <div className="mb-8 bg-blue-50 border border-blue-200 p-4 rounded-2xl flex items-start gap-3">
          <div className="p-2 bg-blue-100 rounded-xl text-blue-600">
            <ExternalLink className="w-5 h-5" />
          </div>
          <div className="text-sm text-blue-800">
            <p className="font-bold mb-1">Public Sharing Enabled</p>
            <p>The QR codes below now point to your <strong>Shared App URL</strong>. This allows anyone to view your models in AR without logging in.</p>
            <div className="mt-3 p-3 bg-blue-100/50 rounded-xl border border-blue-200">
              <p className="font-bold text-xs uppercase tracking-wider mb-1">Important:</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>Make sure you have clicked the <strong>"Share"</strong> button in the top right of the AI Studio editor.</li>
                <li>If you see "Page Not Found", wait 30 seconds for the public URL to become active.</li>
                <li>To test on your phone, scan the QR code or use the <a href={publicOrigin} target="_blank" rel="noopener noreferrer" className="font-bold underline">Public Link</a>.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      <header className="mb-12 flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-orange-500 rounded-2xl shadow-lg shadow-orange-200">
            <Utensils className="w-8 h-8 text-white" />
          </div>
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-neutral-900">FoodAR</h1>
            <p className="text-neutral-500">Upload 3D food models and view them in AR</p>
          </div>
        </div>
        
        {user ? (
          <div className="flex items-center gap-4 bg-white p-2 pr-4 rounded-2xl border border-neutral-200 shadow-sm">
            <div className="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center text-orange-600">
              <User className="w-6 h-6" />
            </div>
            <div className="text-left">
              <p className="text-sm font-bold leading-none mb-1">{user.displayName}</p>
              <p className="text-[10px] text-neutral-500 uppercase tracking-wider font-bold">Chef Account</p>
            </div>
            <div className="w-px h-8 bg-neutral-200 mx-2" />
            <button 
              onClick={handleLogout}
              className="p-2 bg-neutral-100 rounded-xl hover:bg-red-50 hover:text-red-600 transition-all text-neutral-600"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        ) : (
          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className={`flex items-center gap-3 bg-neutral-900 text-white px-8 py-4 rounded-2xl font-bold hover:bg-neutral-800 transition-all shadow-xl shadow-neutral-200 ${isLoggingIn ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isLoggingIn ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <LogIn className="w-5 h-5" />
            )}
            {isLoggingIn ? 'Logging in...' : 'Login with Google'}
          </button>
        )}
      </header>

      <div className="grid lg:grid-cols-2 gap-12">
        {/* Upload Section */}
        <section className="space-y-8">
          {!user && (
            <div className="bg-orange-50 border border-orange-200 p-8 rounded-[32px] text-orange-800 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-4 opacity-10">
                <Utensils className="w-24 h-24" />
              </div>
              <p className="font-bold text-xl mb-2">Login Required</p>
              <p className="text-sm leading-relaxed opacity-80">Please login with your Google account to upload and manage your 3D models. Other users can view your models without logging in.</p>
            </div>
          )}
          
          <div className={`bg-white p-8 rounded-[32px] border border-neutral-200 shadow-sm transition-opacity ${!user ? 'opacity-50 pointer-events-none' : ''}`}>
            <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <Upload className="w-5 h-5 text-orange-600" />
              </div>
              Direct Upload
            </h2>
            <div className="space-y-6">
              <label className="group relative flex flex-col items-center justify-center w-full h-56 border-2 border-dashed border-neutral-200 rounded-3xl cursor-pointer hover:border-orange-400 hover:bg-orange-50/30 transition-all">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mb-4 group-hover:scale-110 group-hover:bg-orange-100 transition-all">
                    <Upload className="w-8 h-8 text-neutral-400 group-hover:text-orange-600 transition-colors" />
                  </div>
                  <p className="mb-2 text-sm text-neutral-500">
                    <span className="font-bold text-neutral-900">Click to upload</span> or drag and drop
                  </p>
                  <p className="text-xs text-neutral-400 font-medium">GLB, USDZ, or GLTF (MAX. 50MB)</p>
                </div>
                <input 
                  type="file" 
                  className="hidden" 
                  accept=".glb,.usdz,.gltf" 
                  onChange={handleFileUpload}
                  disabled={uploading}
                />
                {uploading && (
                  <div className="absolute inset-0 bg-white/90 backdrop-blur-sm rounded-3xl flex items-center justify-center z-20 p-8">
                    <div className="flex flex-col items-center gap-4 w-full max-w-xs">
                      <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
                      <div className="w-full space-y-2">
                        <div className="flex justify-between text-xs font-bold text-orange-600 uppercase tracking-widest">
                          <span>Uploading Model...</span>
                          <span>{uploadProgress}%</span>
                        </div>
                        <div className="w-full h-2 bg-orange-100 rounded-full overflow-hidden">
                          <motion.div 
                            className="h-full bg-orange-500"
                            initial={{ width: 0 }}
                            animate={{ width: `${uploadProgress}%` }}
                            transition={{ duration: 0.1 }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </label>
              
              <div className="bg-blue-50 p-5 rounded-2xl flex gap-4 border border-blue-100">
                <div className="p-2 bg-blue-100 rounded-xl shrink-0 h-fit">
                  <Check className="w-4 h-4 text-blue-600" />
                </div>
                <div className="text-xs text-blue-800 space-y-1.5">
                  <p className="font-bold uppercase tracking-wider">Pro Tip:</p>
                  <p className="leading-relaxed">
                    <strong>.glb</strong> is the universal format for both Android & iOS. 
                    <strong>.usdz</strong> is iOS-only and will not work on Android devices. 
                    For maximum compatibility, always prefer <strong>.glb</strong>.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className={`bg-white p-8 rounded-[32px] border border-neutral-200 shadow-sm transition-opacity ${!user ? 'opacity-50 pointer-events-none' : ''}`}>
            <h2 className="text-xl font-bold mb-6 flex items-center gap-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <LinkIcon className="w-5 h-5 text-orange-600" />
              </div>
              Google Drive Link
            </h2>
            <form onSubmit={handleLinkSubmit} className="space-y-5">
              <div>
                <label className="block text-xs font-bold text-neutral-400 uppercase tracking-widest mb-2">Model Name</label>
                <input 
                  type="text" 
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="e.g. Delicious Pizza"
                  className="w-full px-5 py-4 rounded-2xl border border-neutral-200 focus:ring-4 focus:ring-orange-500/10 focus:border-orange-500 outline-none transition-all bg-neutral-50/50"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-neutral-400 uppercase tracking-widest mb-2">Drive Link</label>
                <input 
                  type="url" 
                  value={driveLink}
                  onChange={(e) => setDriveLink(e.target.value)}
                  placeholder="https://drive.google.com/..."
                  className="w-full px-5 py-4 rounded-2xl border border-neutral-200 focus:ring-4 focus:ring-orange-500/10 focus:border-orange-500 outline-none transition-all bg-neutral-50/50"
                />
              </div>
              <button 
                type="submit"
                className="w-full bg-neutral-900 text-white py-4 rounded-2xl font-bold hover:bg-neutral-800 transition-all shadow-lg shadow-neutral-100"
              >
                Add Link
              </button>
            </form>
          </div>
        </section>

        {/* List Section */}
        <section className="space-y-8">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-neutral-900 flex items-center gap-3">
              Your Models
              <span className="text-xs font-bold text-neutral-400 bg-neutral-100 px-3 py-1 rounded-full">
                {models.length}
              </span>
            </h2>
          </div>
          
          <div className="space-y-5">
            <AnimatePresence mode="popLayout">
              {models.map((model) => (
                <motion.div 
                  key={model.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-white p-6 rounded-[32px] border border-neutral-200 shadow-sm flex flex-col sm:flex-row items-center gap-6 group hover:border-orange-200 transition-colors"
                >
                  <div className="p-4 bg-neutral-50 rounded-3xl relative group/qr">
                    <QRCodeCanvas 
                      id={`qr-${model.id}`}
                      value={`${publicOrigin}/ar/${model.id}`} 
                      size={100}
                      level="H"
                      includeMargin={false}
                    />
                    <button 
                      onClick={() => downloadQR(model.id, model.name)}
                      className="absolute inset-0 bg-orange-500/90 backdrop-blur-sm rounded-3xl opacity-0 group-hover/qr:opacity-100 transition-opacity flex flex-col items-center justify-center text-white gap-1"
                    >
                      <Download className="w-6 h-6" />
                      <span className="text-[10px] font-bold uppercase tracking-tighter">Download</span>
                    </button>
                  </div>
                  
                  <div className="flex-1 min-w-0 w-full">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      {editingId === model.id ? (
                        <div className="flex items-center gap-2 w-full">
                          <input 
                            autoFocus
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && saveName()}
                            className="flex-1 px-3 py-1 text-lg font-bold border-b-2 border-orange-500 outline-none bg-transparent"
                          />
                          <button onClick={saveName} className="p-1 text-green-600 hover:bg-green-50 rounded-lg">
                            <Check className="w-5 h-5" />
                          </button>
                          <button onClick={() => setEditingId(null)} className="p-1 text-red-600 hover:bg-red-50 rounded-lg">
                            <X className="w-5 h-5" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <h3 className="font-bold text-xl truncate text-neutral-900 group-hover:text-orange-600 transition-colors">
                            {model.name}
                          </h3>
                          <button 
                            onClick={() => startEditing(model)}
                            className="p-1.5 text-neutral-400 hover:text-orange-500 hover:bg-orange-50 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-3 mb-4">
                      <p className="text-xs text-neutral-400 font-bold uppercase tracking-widest flex items-center gap-2">
                        {model.type === "file" ? <Upload className="w-3 h-3" /> : <LinkIcon className="w-3 h-3" />}
                        {new Date(model.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                      <span className={`text-[10px] px-2 py-0.5 rounded-md font-bold uppercase tracking-tighter ${
                        model.url.toLowerCase().endsWith('.usdz') 
                        ? 'bg-blue-50 text-blue-600 border border-blue-100' 
                        : 'bg-green-50 text-green-600 border border-green-100'
                      }`}>
                        {model.url.toLowerCase().endsWith('.usdz') ? 'iOS Only' : 'Universal'}
                      </span>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <a 
                        href={`/ar/${model.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 bg-neutral-900 text-white text-xs font-bold py-3 rounded-xl flex items-center justify-center gap-2 hover:bg-orange-500 transition-all shadow-lg shadow-neutral-100"
                      >
                        <ExternalLink className="w-4 h-4" />
                        Preview AR
                      </a>

                      <button 
                        onClick={() => {
                          const url = `${publicOrigin}/ar/${model.id}`;
                          navigator.clipboard.writeText(url);
                          alert("Link copied to clipboard!");
                        }}
                        className="p-3 bg-neutral-100 text-neutral-600 rounded-xl hover:bg-orange-100 hover:text-orange-600 transition-all"
                        title="Copy AR Link"
                      >
                        <LinkIcon className="w-4 h-4" />
                      </button>
                      
                      <div className="relative">
                        <AnimatePresence>
                          {deletingId === model.id ? (
                            <motion.div 
                              initial={{ opacity: 0, scale: 0.9, x: 10 }}
                              animate={{ opacity: 1, scale: 1, x: 0 }}
                              exit={{ opacity: 0, scale: 0.9, x: 10 }}
                              className="absolute right-0 bottom-0 flex items-center gap-2 bg-white p-1 rounded-xl border border-red-100 shadow-xl z-10 whitespace-nowrap"
                            >
                              <button 
                                onClick={() => deleteModel(model.id)}
                                className="px-3 py-2 bg-red-600 text-white text-[10px] font-bold uppercase rounded-lg hover:bg-red-700 transition-colors"
                              >
                                Confirm Delete
                              </button>
                              <button 
                                onClick={() => setDeletingId(null)}
                                className="p-2 text-neutral-400 hover:bg-neutral-100 rounded-lg transition-colors"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </motion.div>
                          ) : (
                            <button 
                              onClick={() => setDeletingId(model.id)}
                              className="p-3 bg-neutral-100 text-neutral-400 hover:bg-red-50 hover:text-red-600 rounded-xl transition-all"
                              title="Delete Model"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {models.length === 0 && (
              <div className="text-center py-20 bg-neutral-50 rounded-[40px] border-2 border-dashed border-neutral-200">
                <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-sm">
                  <Utensils className="w-8 h-8 text-neutral-300" />
                </div>
                <p className="text-neutral-500 font-bold">No models uploaded yet</p>
                <p className="text-xs text-neutral-400 mt-1">Your 3D food collection starts here</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
