import { Outlet } from 'react-router'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

export function AppShell(): React.JSX.Element {
  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* `relative` keeps stray absolutely positioned bits — the hidden inputs Radix renders beside a radio or a
            checkbox — inside the one box that scrolls, instead of letting them stretch the document itself. */}
        <main className="relative flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
