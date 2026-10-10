// The one footer every long list on the site uses: how many rows are on screen out of how many, and a button that reveals the next page
// (review of 2026-10-10: long lists are cut at LIST_PAGE rows and grow on request, never dumped whole).
import { LIST_PAGE } from "../lib/evidenceFiles";

export function ShowMore({ shown, total, onMore, noun = "rows", step = LIST_PAGE, testId }: { shown: number; total: number; onMore: () => void; noun?: string; step?: number; testId?: string }) {
  if (total <= shown && total <= step) return null;
  const hidden = Math.max(0, total - shown);
  return (
    <div className="showmore row between" data-testid={testId}>
      <span className="tiny dim">{`${Math.min(shown, total)} of ${total} ${noun}`}</span>
      {hidden > 0 && <button type="button" className="btn sm ghost" onClick={onMore}>{`show ${Math.min(step, hidden)} more`}</button>}
    </div>
  );
}
