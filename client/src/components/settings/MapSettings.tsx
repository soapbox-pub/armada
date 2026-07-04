import { Download, Map, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { MapDownloadDialog } from "@/components/map/MapDownloadDialog";
import { RegionViewDialog } from "@/components/map/RegionViewDialog";
import { SettingsRow } from "@/components/settings/SettingsSection";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { getTileStore } from "@/lib/map/getTileStore";
import {
  deleteRegionRecord,
  listRegions,
  renameRegion,
  totalRegionBytes,
  type RegionRecord,
} from "@/lib/map/offlineManifest";
import { formatBytes } from "@/lib/map/tileMath";

/**
 * "Map" settings body: offline region management. Lists downloaded regions
 * (name · size · delete/rename), shows total storage used, and opens the
 * {@link MapDownloadDialog} to grab a new area. Region tile bytes live in the
 * platform tile store (native Filesystem / web IndexedDB); this UI reads the
 * manifest catalog and deletes both the catalog record and the stored bytes.
 */
export function MapSettings() {
  const [regions, setRegions] = useState<RegionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [viewing, setViewing] = useState<RegionRecord | null>(null);
  const [clearAllOpen, setClearAllOpen] = useState(false);

  const refresh = useCallback(async () => {
    setRegions(await listRegions());
    setTotal(await totalRegionBytes());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string) => {
    await getTileStore().deleteRegion(id);
    await deleteRegionRecord(id);
    await refresh();
  };

  const removeAll = async () => {
    await getTileStore().clearAll();
    await Promise.all(regions.map((r) => deleteRegionRecord(r.id)));
    setClearAllOpen(false);
    await refresh();
  };

  const rename = async (region: RegionRecord) => {
    const next = window.prompt("Rename region", region.name);
    if (next && next.trim() && next.trim() !== region.name) {
      await renameRegion(region.id, next.trim());
      await refresh();
    }
  };

  return (
    <>
      <SettingsRow
        label="Download an area"
        description="Save map tiles for offline use, anchored on your location."
      >
        <Button size="sm" className="gap-1.5" onClick={() => setDownloadOpen(true)}>
          <Download className="size-4" />
          Download
        </Button>
      </SettingsRow>

      {regions.length === 0 ? (
        <SettingsRow>
          <p className="text-sm text-muted-foreground">No offline areas downloaded yet.</p>
        </SettingsRow>
      ) : (
        regions.map((region) => (
          <SettingsRow key={region.id} label={region.name} onClick={() => rename(region)}>
            <div className="flex items-center gap-3">
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatBytes(region.bytes)}
              </span>
              <button
                type="button"
                aria-label={`View ${region.name}`}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewing(region);
                }}
              >
                <Map className="size-4" />
              </button>
              <button
                type="button"
                aria-label={`Delete ${region.name}`}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(region.id);
                }}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          </SettingsRow>
        ))
      )}

      {regions.length > 0 && (
        <SettingsRow label="Total offline storage">
          <div className="flex items-center gap-3">
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatBytes(total)}
            </span>
            <button
              type="button"
              aria-label="Delete all offline areas"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setClearAllOpen(true)}
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        </SettingsRow>
      )}

      {downloadOpen && (
        <MapDownloadDialog
          onDownloaded={() => void refresh()}
          onClose={() => setDownloadOpen(false)}
        />
      )}

      {viewing && (
        <RegionViewDialog region={viewing} onClose={() => setViewing(null)} />
      )}

      <AlertDialog open={clearAllOpen} onOpenChange={setClearAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all offline areas?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes every downloaded map region ({formatBytes(total)}). You can
              download them again later while online.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void removeAll()}
            >
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
