import { Link } from "next-view-transitions";

import { SHOWCASE_ITEMS } from "@/lib/showcase";

export const dynamic = "force-static";

export default function ShowcaseIndexPage() {
  return (
    <div className="prose markdown flex flex-col space-y-3 text-foreground">
      <h1>Showcase</h1>
      <p>Feature-focused articles and demos.</p>
      <ul>
        {SHOWCASE_ITEMS.map((item) => (
          <li key={item.slug}>
            <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href={`/showcase/${item.slug}`}>
              {item.title}
            </Link>
            {item.description ? <div className="text-muted-old text-small">{item.description}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

