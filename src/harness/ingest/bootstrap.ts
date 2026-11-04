import { registerDirectoryAdapter } from "./registry";
import { kemenperinAdapter } from "./kemenperin";
import { kemendagEximAdapter } from "./kemendagexim";
import { indotradingAdapter } from "./indotrading";
import { indonetworkAdapter } from "./indonetwork";

let registered = false;

export function ensureAdaptersRegistered(): void {
  if (registered) return;
  registered = true;
  registerDirectoryAdapter(kemenperinAdapter);
  registerDirectoryAdapter(kemendagEximAdapter);
  registerDirectoryAdapter(indotradingAdapter);
  registerDirectoryAdapter(indonetworkAdapter);
}
