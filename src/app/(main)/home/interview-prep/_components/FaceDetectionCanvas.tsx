"use client";
import React, { useEffect, useRef, useState } from "react";
import * as faceapi from "@vladmandic/face-api";
import { LuShieldAlert, LuUserCheck, LuUserX } from "react-icons/lu";
import { toast } from "sonner";

interface FaceDetectionCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isCameraOn: boolean;
  onFaceCountChange?: (count: number) => void;
}

export const FaceDetectionCanvas: React.FC<FaceDetectionCanvasProps> = ({
  videoRef,
  isCameraOn,
  onFaceCountChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [faceCount, setFaceCount] = useState<number>(0);
  const [isLoadingModel, setIsLoadingModel] = useState<boolean>(true);
  const [modelError, setModelError] = useState<string | null>(null);
  const lastToastTimeRef = useRef<number>(0);

  // Trigger alert toast whenever multiple faces are detected
  useEffect(() => {
    if (faceCount > 1) {
      const now = Date.now();
      if (now - lastToastTimeRef.current > 4000) {
        lastToastTimeRef.current = now;
        toast.error(`⚠️ Multiple Faces Detected (${faceCount})`, {
          description:
            "Proctoring Alert: Please ensure you are alone during the interview session.",
          duration: 4000,
        });
      }
    }
  }, [faceCount]);

  // Load TinyFaceDetector model once on mount
  useEffect(() => {
    let isMounted = true;
    const loadModels = async () => {
      try {
        setIsLoadingModel(true);
        const MODEL_URL =
          "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        if (isMounted) {
          setIsLoadingModel(false);
        }
      } catch (err: any) {
        console.error("Failed to load face detection model:", err);
        if (isMounted) {
          setModelError("Failed to initialize AI face detection model");
          setIsLoadingModel(false);
        }
      }
    };

    loadModels();
    return () => {
      isMounted = false;
    };
  }, []);

  // Throttled Detection Loop (every 300ms instead of 60fps for low bandwidth/cpu)
  useEffect(() => {
    if (!isCameraOn || isLoadingModel || modelError) return;

    let intervalId: NodeJS.Timeout;
    let isDetecting = false;

    const detect = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (
        video &&
        canvas &&
        video.readyState >= 2 &&
        !video.paused &&
        !video.ended
      ) {
        if (!isDetecting) {
          isDetecting = true;
          try {
            const displaySize = {
              width: video.clientWidth || video.videoWidth || 640,
              height: video.clientHeight || video.videoHeight || 480,
            };

            if (
              canvas.width !== displaySize.width ||
              canvas.height !== displaySize.height
            ) {
              faceapi.matchDimensions(canvas, displaySize);
            }

            const options = new faceapi.TinyFaceDetectorOptions({
              inputSize: 160, // Reduced input size from 224 for faster CPU detection on slow networks
              scoreThreshold: 0.4,
            });

            const detections = await faceapi.detectAllFaces(video, options);
            const count = detections.length;

            setFaceCount(count);
            if (onFaceCountChange) {
              onFaceCountChange(count);
            }

            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.clearRect(0, 0, canvas.width, canvas.height);

              const resizedDetections = faceapi.resizeResults(
                detections,
                displaySize
              );
              resizedDetections.forEach((det) => {
                const { x, y, width, height } = det.box;

                const isMultiple = count > 1;
                const strokeColor = isMultiple ? "#ef4444" : "#22c55e";

                ctx.strokeStyle = strokeColor;
                ctx.lineWidth = 3;
                ctx.strokeRect(x, y, width, height);

                ctx.fillStyle = strokeColor;
                const labelText = isMultiple
                  ? "Unauthorized Person"
                  : "Candidate Verified";
                ctx.font = "bold 12px sans-serif";
                const textWidth = ctx.measureText(labelText).width;

                ctx.fillRect(x, Math.max(0, y - 22), textWidth + 12, 22);

                ctx.fillStyle = "#ffffff";
                ctx.fillText(labelText, x + 6, Math.max(14, y - 6));
              });
            }
          } catch (e) {
            console.error("Face detection loop error:", e);
          } finally {
            isDetecting = false;
          }
        }
      }
    };

    intervalId = setInterval(detect, 300);

    return () => {
      if (intervalId) clearInterval(intervalId);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }, [isCameraOn, isLoadingModel, modelError, videoRef, onFaceCountChange]);

  if (!isCameraOn) return null;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-10"
      />

      {/* Real-Time Security Badge Status Overlay */}
      <div className="absolute top-3 left-3 z-20 flex flex-col gap-2">
        {faceCount > 1 && (
          <div className="bg-red-600/90 backdrop-blur text-white px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 shadow-lg animate-bounce">
            <LuShieldAlert className="w-4 h-4 text-white" />
            <span>Multiple Faces Detected ({faceCount}) - Security Warning</span>
          </div>
        )}

        {faceCount === 1 && (
          <div className="bg-emerald-600/90 backdrop-blur text-white px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 shadow-md">
            <LuUserCheck className="w-4 h-4" />
            <span>Candidate Verified (1 Face)</span>
          </div>
        )}

        {faceCount === 0 && !isLoadingModel && (
          <div className="bg-amber-500/90 backdrop-blur text-white px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 shadow-md">
            <LuUserX className="w-4 h-4" />
            <span>No Candidate Detected in Camera</span>
          </div>
        )}

        {isLoadingModel && (
          <div className="bg-gray-900/80 backdrop-blur text-gray-200 px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-ping" />
            <span>Initializing Face AI Guard...</span>
          </div>
        )}
      </div>
    </>
  );
};
