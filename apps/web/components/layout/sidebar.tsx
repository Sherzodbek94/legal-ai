import { SidebarBrand } from './sidebar-brand';
import { SidebarNav } from './sidebar-nav';

/**
 * Persistent desktop rail. Hidden below `lg`, where MobileNav takes over.
 */
export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
      <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4">
        <SidebarBrand />
      </div>
      <SidebarNav />
      <div className="shrink-0 border-t border-sidebar-border px-5 py-4">
        <p className="text-xs text-sidebar-muted">
          Confidential — attorney work product
        </p>
      </div>
    </aside>
  );
}
