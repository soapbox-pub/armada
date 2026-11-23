import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Blob as NodeBlob } from "node:buffer";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageCropDialog } from "@/components/ImageCropDialog";

const h = vi.hoisted(() => ({ intact: true }));

vi.mock("@/lib/canvasProbe", () => ({ canvasReadbackIntact: () => h.intact }));

// Stands in for react-easy-crop: reports a crop area once mounted.
vi.mock("react-easy-crop", () => ({
  default: function Cropper({ onCropComplete }: { onCropComplete: (a: unknown, b: unknown) => void }) {
    useEffect(() => {
      onCropComplete({}, { x: 10, y: 10, width: 20, height: 20 });
    }, [onCropComplete]);
    return null;
  },
}));

/** SOI, an APP1 carrying EXIF (GPS lives here), a DQT, then a scan. */
const JPEG_WITH_EXIF = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50,
  0xff, 0xdb, 0x00, 0x04, 0x01, 0x02,
  0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
]);
const JPEG_STRIPPED = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xdb, 0x00, 0x04, 0x01, 0x02,
  0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
]);
/** An ISO-BMFF (HEIC) header: its EXIF can't be cut out structurally. */
const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);

function serve(bytes: Uint8Array, type: string) {
  // jsdom's Blob has no arrayBuffer().
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("fetch", async () => ({ blob: async () => new NodeBlob([bytes.slice()], { type }) }));
}

afterEach(() => {
  h.intact = true;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ImageCropDialog where a fingerprint blocker poisons canvas readback", () => {
  it("hands back the picked image without its metadata instead of a canvas re-encode", async () => {
    h.intact = false;
    serve(JPEG_WITH_EXIF, "image/jpeg");
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const onCrop = vi.fn();
    render(<ImageCropDialog open imageSrc="blob:picked" aspect={1} maxEdge={512} onCancel={() => {}} onCrop={onCrop} />);

    expect(screen.getByText(/blocks the canvas used to crop images/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));

    await waitFor(() => expect(onCrop).toHaveBeenCalledTimes(1));
    const blob = onCrop.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("image/jpeg");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(JPEG_STRIPPED);
    expect(getContext).not.toHaveBeenCalled();
  });

  it("refuses an image whose metadata can only be removed by a canvas", async () => {
    h.intact = false;
    serve(HEIC, "image/heic");
    const onCrop = vi.fn();
    render(<ImageCropDialog open imageSrc="blob:picked" aspect={1} onCancel={() => {}} onCrop={onCrop} />);

    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("can't be used in this browser");
    expect(onCrop).not.toHaveBeenCalled();
  });

  it("says nothing about the canvas where readback is honest", () => {
    render(<ImageCropDialog open imageSrc="blob:picked" aspect={1} onCancel={() => {}} onCrop={() => {}} />);
    expect(screen.queryByText(/blocks the canvas/)).not.toBeInTheDocument();
  });
});
