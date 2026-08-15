/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { ChatGroq } from "@langchain/groq";
import { NextResponse } from "next/server";
import { jsonrepair } from "jsonrepair";
import { tavily } from "@tavily/core";

// Schema non-strict
const RoadmapSchema = z.object({
  roadmapTitle: z.string().optional(),
  description: z.string().optional(),
  duration: z.string().optional(),
  initialNodes: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.string().optional(),
        position: z
          .object({
            x: z.number().optional(),
            y: z.number().optional(),
          })
          .optional(),
        data: z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
            link: z.string().optional(),
          })
          .optional(),
      })
    )
    .optional(),
  initialEdges: z
    .array(
      z.object({
        id: z.string().optional(),
        source: z.string().optional(),
        target: z.string().optional(),
      })
    )
    .optional(),
});

const parser = StructuredOutputParser.fromZodSchema(RoadmapSchema as any);

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("GROQ_API_KEY is missing");
      return NextResponse.json({ error: "Groq is not configured" }, { status: 500 });
    }

    const model = new ChatGroq({
      apiKey,
      model: "llama-3.3-70b-versatile",
      temperature: 0.3,
      maxTokens: 1500,
    });
    const body = await req.json();
    const field = body.field || "Software Developer";
    const timeline = body.timeline || "3 months";
    const mode = body.mode || "Beginner";
    const formatInstructions = parser.getFormatInstructions();

    const firstPrompt = `
You are an Elite Industry Principal Architect & Senior Mentor.

Task: Generate a cutting-edge learning roadmap for "${field}" (${timeline}, ${mode} level).

DIRECTIVES:
1. ONLY include the exact current production tools, frameworks, libraries, and APIs actively used by top tech companies for "${field}" as per current year.
2. NO generic textbook terms. NO "Introduction to X". NO vague concepts.
3. Each description MUST be exactly 1 short sentence (max 15 words) naming the tool and its core production use.

GRID POSITIONS (3-column layout, grid index coordinates):
• node-1: { x: 0, y: 0 }
• node-2: { x: 1, y: 0 }
• node-3: { x: 2, y: 0 }
• node-4: { x: 0, y: 1 }
• node-5: { x: 1, y: 1 }
• node-6: { x: 2, y: 1 }
• node-7: { x: 0, y: 2 }

NODE STRUCTURE:
- id: "node-1", "node-2", etc.
- type: "default"
- position: grid coordinate above
- data.title: concise tool/framework title (e.g. "LangChain & LCEL Chains")
- data.description: exactly 1 sentence, max 15 words, naming the tool and what to build.
- data.link: search query string (e.g. "LangGraph StateGraph agentic workflow tutorial")

EDGES: Connect all nodes sequentially: node-1 → node-2 → ... → node-7.

Return ONLY valid JSON.

${formatInstructions}
`;

    const firstResponse = await model.invoke(firstPrompt);
    let repairedJSON: string;
    try {
      repairedJSON = jsonrepair(firstResponse.content as string);
    } catch {
      repairedJSON = firstResponse.content as string;
    }

    const secondPrompt = `
Validate and fix this roadmap JSON for "${field}" (${timeline}, ${mode}):
${repairedJSON}

Fix if any of these are wrong:
1. roadmapTitle, description (1-2 lines), duration "${timeline}".
2. 6-7 nodes with correct modern tools for "${field}". Descriptions MUST be 1 sentence max 15 words.
3. Grid positions: node-1:{x:0,y:0}, node-2:{x:1,y:0}, node-3:{x:2,y:0}, node-4:{x:0,y:1}, node-5:{x:1,y:1}, node-6:{x:2,y:1}, node-7:{x:0,y:2}.
4. Sequential edges: node-1→node-2→...→node-7.

Return valid JSON only.

${formatInstructions}
`;

    const secondResponse = await model.invoke(secondPrompt);

    let secondRepairedJSON: string;
    try {
      secondRepairedJSON = jsonrepair(secondResponse.content as string);
    } catch (repairErr) {
      console.warn(
        "Second JSON repair failed, using raw LLM output",
        repairErr
      );
      secondRepairedJSON = secondResponse.content as string;
    }

    const finalParsed: any = await parser.parse(secondRepairedJSON);

    // 🔹 Tavily Real-Time Web Search for Exact Official Documentation Links
    const tavilyKey =
      process.env.NEXT_PUBLIC_TAVILY_API_KEY || process.env.TAVILY_API_KEY;

    if (tavilyKey && finalParsed?.initialNodes && Array.isArray(finalParsed.initialNodes)) {
      try {
        const tvly = tavily({ apiKey: tavilyKey });
        await Promise.all(
          finalParsed.initialNodes.map(async (node: any) => {
            const topic = node.data?.title || field;
            try {
              const searchRes = await tvly.search(
                `${topic} official documentation tutorial`,
                {
                  search_depth: "basic",
                  max_results: 1,
                }
              );

              if (searchRes?.results?.[0]?.url) {
                if (!node.data) node.data = {};
                node.data.link = searchRes.results[0].url;
              }
            } catch (err) {
              console.warn("Tavily search failed for topic:", topic, err);
            }
          })
        );
      } catch (err) {
        console.error("Tavily initialization failed:", err);
      }
    }

    return NextResponse.json(finalParsed);
  } catch (error: any) {
    console.error("Roadmap generation error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
