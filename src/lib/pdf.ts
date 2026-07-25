const MIN_TEXT_CHARACTERS = 100;
const MIN_CHARACTERS_PER_PAGE = 25;

export type PdfTextResult = {
  text: string;
  pageCount: number;
  durationMs: number;
  usable: boolean;
};

export async function extractPdfText(file: File): Promise<PdfTextResult> {
  const startedAt = performance.now();
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);

  GlobalWorkerOptions.workerSrc = workerModule.default;
  const document = await getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = "";

    for (const item of content.items) {
      if (!("str" in item)) continue;
      pageText += item.str;
      pageText += item.hasEOL ? "\n" : " ";
    }

    pages.push(pageText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
    page.cleanup();
  }

  const text = pages.filter(Boolean).join("\n\n--- PAGE BREAK ---\n\n");
  const meaningfulCharacters = text.replace(/\s/g, "").length;

  return {
    text,
    pageCount: document.numPages,
    durationMs: performance.now() - startedAt,
    usable:
      meaningfulCharacters >= MIN_TEXT_CHARACTERS &&
      meaningfulCharacters / Math.max(document.numPages, 1) >= MIN_CHARACTERS_PER_PAGE,
  };
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
