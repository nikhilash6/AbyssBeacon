"""Bound collection HTML while searching the complete repository snapshot."""
import math
from urllib.parse import urlencode


def paginate_collection(groups, repository_files, args):
    query = str(args.get("q", ""))[:200].strip()
    alpha = str(args.get("alpha", "all"))
    order = str(args.get("sort", "alpha"))
    changed = args.get("changed") == "1"
    available = sorted({letter for group in groups for letter in group.get("alpha_buckets", [])})
    matches = [group for group in groups
               if (not query or query.casefold() in str(group.get("search_text", "")).casefold())
               and (alpha == "all" or alpha in group.get("alpha_buckets", []))
               and (not changed or group.get("change_badges"))]
    if order in {"new", "updated"}:
        key = "first_seen" if order == "new" else "updated_at"
        matches.sort(key=lambda group: group.get(key) or "", reverse=True)
    def number(key, total):
        try:
            return min(max(1, int(args.get(key, 1))), max(1, math.ceil(total / 100)))
        except (ValueError, TypeError):
            return 1
    page = number("page", len(matches))
    repo_page = number("repo_page", len(repository_files))
    def link(key, value):
        params = dict(args)
        params[key] = value
        return "?" + urlencode(params) + ("#collectionFamilyTools" if key == "page" else "#repositoryFiles")
    return dict(page_groups=matches[(page-1)*100:page*100],
                page_repository_files=repository_files[(repo_page-1)*100:repo_page*100],
                collection_query=query, collection_alpha=alpha, collection_sort=order,
                collection_changed=changed, available_alpha=available,
                collection_page=page, collection_pages=max(1, math.ceil(len(matches)/100)),
                collection_match_count=len(matches), collection_start=(page-1)*100+1 if matches else 0,
                collection_end=min(page*100, len(matches)),
                collection_previous=link("page", page-1), collection_next=link("page", page+1),
                repository_page=repo_page, repository_pages=max(1, math.ceil(len(repository_files)/100)),
                repository_previous=link("repo_page", repo_page-1), repository_next=link("repo_page", repo_page+1))
