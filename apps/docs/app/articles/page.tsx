import { Link } from "next-view-transitions";

import { ARTICLE_ITEMS } from "@/lib/articles";

export const dynamic = "force-static";

export default function ArticlesIndexPage() {
  return (
    <div className="prose markdown flex flex-col space-y-3 text-foreground">
      <h1>Articles</h1>
      <p>Deep dives and implementation notes for StreamMDX.</p>
      <ul>
        {ARTICLE_ITEMS.map((item) => (
          <li key={item.slug}>
            <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href={`/articles/${item.slug}`}>
              {item.title}
            </Link>
            {item.description ? <div className="text-muted-old text-small">{item.description}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
