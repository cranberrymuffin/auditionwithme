import { useEffect, useRef } from "react";
import { NativeMedia } from "../../lib/native/nativeMedia";

/**
 * The camera preview in the iOS app: the phone draws it natively, over the
 * web view, exactly where this box sits. The box only reserves the space
 * (same size as the web preview's <video>) and keeps the native layer
 * lined up as the page lays out, scrolls or rotates. Because the layer sits
 * above the page, it steps aside while a modal is open and goes away with
 * the box. App only — browsers keep the <video> preview.
 */
export default function NativeCameraPreview({ className }: { className?: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let frame = 0;
    let shown = false;

    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = box.getBoundingClientRect();
        const modalOpen = Boolean(document.querySelector(".modal-overlay"));
        const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
        if (modalOpen || !visible) {
          if (shown) void NativeMedia.hidePreview();
          shown = false;
          return;
        }
        shown = true;
        void NativeMedia.showPreview({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          cornerRadius: parseFloat(getComputedStyle(box).borderRadius) || 0,
        });
      });
    };

    place();
    const resize = new ResizeObserver(place);
    resize.observe(box);
    // Modals render through a portal into <body>.
    const modals = new MutationObserver(place);
    modals.observe(document.body, { childList: true });
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      modals.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      void NativeMedia.hidePreview();
    };
  }, []);

  return <div ref={boxRef} className={className} aria-label="Camera preview" role="img" />;
}
