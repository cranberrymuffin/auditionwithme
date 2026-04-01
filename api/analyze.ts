import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

const client = new Anthropic();

const PROMPT = `This PDF contains audition sides or a script. It may include annotations, strikethroughs, margin notes, highlighted sections, and other markings made by directors, casting agents, or actors.

Please analyze the PDF carefully and generate a clean audition script by:
1. Identifying which lines are ACTIVE — ignore any lines that are struck through or crossed out
2. Extracting all character names and their dialogue
3. Including relevant stage directions
4. Noting any important annotations that affect how lines should be performed

Format the output as:

CHARACTER NAME
Their dialogue here.

(stage direction)

Next lines continue...

The output should be the definitive, clean version of the script the actor should use for their audition. Do not include any meta-commentary — just the formatted script.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  const { pdfData } = req.body as { pdfData?: string };

  if (!pdfData) {
    return res.status(400).json({ error: "No PDF data provided" });
  }

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfData,
              },
            },
            {
              type: "text",
              text: PROMPT,
            },
          ],
        },
      ],
    });

    const script =
      response.content[0].type === "text" ? response.content[0].text : "";

    return res.status(200).json({ script });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Claude API error:", message);
    return res.status(500).json({ error: message });
  }
}
