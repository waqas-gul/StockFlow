import { AboutCard } from '@renderer/components/common/AboutCard'
import { DevChecks } from '@renderer/components/common/DevChecks'
import { BackupRestoreCard } from '@renderer/features/backup/BackupRestoreCard'
import { IntegrityCheckCard } from '@renderer/features/maintenance/IntegrityCheckCard'
import { SettingsSection } from './SettingsForm'

/** Settings: Business, Currency and Invoice; Backup & Restore; Maintenance and About. */
export function SettingsPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pb-6">
      <SettingsSection />
      <BackupRestoreCard />
      <IntegrityCheckCard />
      <AboutCard />
      {import.meta.env.DEV && <DevChecks />}
    </div>
  )
}
