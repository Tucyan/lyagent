import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface SearchableOptionItem {
  value: string;
  label: string;
  badge?: string;
  meta?: string;
  searchText?: string;
}

type PopoverLayout = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  listMaxHeight: number;
};

export function SearchableOptionPicker({
  ariaLabel,
  value,
  options,
  placeholder = "请选择…",
  emptyText = "暂无可选项",
  searchPlaceholder = "搜索名称、版本或状态…",
  disabled = false,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: readonly SearchableOptionItem[];
  placeholder?: string;
  emptyText?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popoverLayout, setPopoverLayout] = useState<PopoverLayout>();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => options.find((item) => item.value === value),
    [options, value],
  );

  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((item) =>
      `${item.label} ${item.badge ?? ""} ${item.meta ?? ""} ${item.searchText ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [options, query]);

  const measurePopoverLayout = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
      setPopoverLayout(undefined);
      return;
    }
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const width = Math.min(Math.max(rect.width, 320), Math.max(220, vw - 24));
    const left = Math.max(12, Math.min(rect.left, vw - width - 12));
    const spaceBelow = vh - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
    const availableHeight = Math.max(140, Math.min(320, openUpward ? spaceAbove : spaceBelow));
    const listMaxHeight = Math.max(96, availableHeight - 72);
    setPopoverLayout({
      ...(openUpward ? { bottom: vh - rect.top + 6 } : { top: rect.bottom + 6 }),
      left,
      width,
      listMaxHeight,
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPopoverLayout(undefined);
      return;
    }
    measurePopoverLayout();
    window.addEventListener("resize", measurePopoverLayout);
    window.addEventListener("scroll", measurePopoverLayout, true);
    return () => {
      window.removeEventListener("resize", measurePopoverLayout);
      window.removeEventListener("scroll", measurePopoverLayout, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const raf = window.requestAnimationFrame?.(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      if (raf !== undefined) window.cancelAnimationFrame?.(raf);
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="searchable-picker" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`searchable-picker-trigger ${open ? "open" : ""}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((current) => !current)}
        title={selected ? `${selected.label}${selected.badge ? ` (${selected.badge})` : ""}` : placeholder}
      >
        <span className="searchable-picker-trigger-label">
          {selected ? selected.label : options.length === 0 ? emptyText : placeholder}
        </span>
        {selected?.badge && (
          <span className="searchable-picker-badge">{selected.badge}</span>
        )}
        <span className="searchable-picker-caret" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div
          className="searchable-picker-popover"
          style={
            popoverLayout
              ? {
                  ...(popoverLayout.top !== undefined ? { top: `${popoverLayout.top}px` } : {}),
                  ...(popoverLayout.bottom !== undefined ? { bottom: `${popoverLayout.bottom}px` } : {}),
                  left: `${popoverLayout.left}px`,
                  width: `${popoverLayout.width}px`,
                }
              : undefined
          }
        >
          <input
            ref={searchInputRef}
            type="search"
            className="searchable-picker-search"
            aria-label={`搜索${ariaLabel}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
          />
          <div
            className="searchable-picker-list"
            role="listbox"
            aria-label={ariaLabel}
            style={popoverLayout ? { maxHeight: `${popoverLayout.listMaxHeight}px` } : undefined}
          >
            {visibleOptions.length === 0 ? (
              <p className="searchable-picker-empty">没有匹配项</p>
            ) : (
              visibleOptions.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`searchable-picker-option ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="searchable-picker-option-main">
                      <strong>{option.label}</strong>
                      {option.meta && <small>{option.meta}</small>}
                    </span>
                    {option.badge && (
                      <span className="searchable-picker-badge">{option.badge}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
