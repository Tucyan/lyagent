import type { Nodes } from "mdast";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const ASSET_PREFIX = "assets/";

function preserveSubmissionAssetPaths() {
  return function visit(node: Nodes): void {
    if (node.type === "image" && node.url.startsWith(ASSET_PREFIX)) {
      node.data ??= {};
      node.data.hProperties = { ...node.data.hProperties, dataAssetPath: node.url };
    }
    if ("children" in node) node.children.forEach(visit);
  };
}

export function SubmissionMarkdown({ sessionId, children, components }: {
  sessionId: string;
  children: string;
  components?: Components;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, preserveSubmissionAssetPaths]}
      components={components}
      urlTransform={(url, key, node) => {
        const assetPath = node.properties.dataAssetPath;
        if (key === "src" && typeof assetPath === "string") {
          return `/api/grading/sessions/${sessionId}/assets/${encodeURIComponent(assetPath.slice(ASSET_PREFIX.length))}`;
        }
        return defaultUrlTransform(url);
      }}
    >
      {children}
    </Markdown>
  );
}
