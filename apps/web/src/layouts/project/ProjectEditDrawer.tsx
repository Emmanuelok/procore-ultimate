/**
 * Edit project details — the workspace header's primary action.
 *
 * PATCH /api/v1/projects/:projectId. The patch schema takes every field as
 * OPTIONAL but not NULLABLE, so a blank box omits the field rather than
 * clearing it. That is stated on the form instead of being discovered: a UI
 * that silently ignores a deletion is worse than one that says it cannot.
 */
import { useEffect, useState, type FormEvent } from "react";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Button, Drawer, ErrorAlert, Skeleton, toast } from "../../ui";
import { IconEdit } from "../../ui/icons";
import { useProjectWorkspace } from "./context";
import {
  EMPTY_PROJECT_FORM,
  ProjectFormFields,
  buildProjectPayload,
  projectFormFrom,
  validateProjectForm,
  type ProjectFormValues,
} from "./ProjectForm";

export interface ProjectEditDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function ProjectEditDrawer({ open, onClose }: ProjectEditDrawerProps) {
  const { project, reloadProject, projectId } = useProjectWorkspace();
  const record = project.data;

  const [values, setValues] = useState<ProjectFormValues>(EMPTY_PROJECT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed from the record every time the drawer opens, so a cancelled edit
  // never leaks into the next one.
  useEffect(() => {
    if (open && record) {
      setValues(projectFormFrom(record));
      setError(null);
    }
  }, [open, record]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const invalid = validateProjectForm(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.patch(`/api/v1/projects/${projectId}`, buildProjectPayload(values));
      reloadProject();
      toast.success("Project updated");
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "The project could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      size="lg"
      title="Edit project details"
      description="Changes are written to the project record and appear across the workspace immediately."
      icon={IconEdit}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="project-edit-form" loading={saving} loadingText="Saving…">
            Save changes
          </Button>
        </>
      }
    >
      {project.loading && !record ? (
        <div className="space-y-4">
          <Skeleton height={64} radius="md" />
          <Skeleton height={180} radius="md" />
          <Skeleton height={120} radius="md" />
        </div>
      ) : !record ? (
        <ErrorAlert
          title="This project could not be read"
          message={project.error ?? "The project record is unavailable."}
          onRetry={reloadProject}
        />
      ) : (
        <form id="project-edit-form" onSubmit={onSubmit} noValidate>
          <ErrorAlert message={error} onDismiss={() => setError(null)} />
          <ProjectFormFields
            values={values}
            onChange={setValues}
            disabled={saving}
            note={
              <Alert tone="info" size="sm" className="mt-3">
                Clearing a box leaves the stored value unchanged — the API accepts a new value for
                these fields but not an empty one. Ask an administrator if a field genuinely needs
                to be emptied.
              </Alert>
            }
          />
        </form>
      )}
    </Drawer>
  );
}
