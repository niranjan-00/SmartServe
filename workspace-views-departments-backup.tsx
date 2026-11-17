
// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

interface DepartmentStatRow {
  id: string
  name: string
  description: string | null
  staffCount: number
  complaintCount: number
  openComplaints: number
  resolvedComplaints: number
}

export function DepartmentsView({ role }: { role: string }) {
  const canManage =
    role === 'ORGANIZATION_ADMIN' || role === 'SUPER_ADMIN'

  const [rows, setRows] = useState<DepartmentStatRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  async function loadDepartments() {
    setLoading(true)
    setError(null)

    try {
      const data = await api.get<{
        departments: DepartmentStatRow[]
      }>('/api/departments')

      setRows(data.departments ?? [])
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not load departments.'
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDepartments()
  }, [])

  function resetForm() {
    setName('')
    setDescription('')
    setEditingId(null)
    setShowForm(false)
  }

  function startEdit(department: DepartmentStatRow) {
    setEditingId(department.id)
    setName(department.name)
    setDescription(department.description ?? '')
    setShowForm(true)
    setError(null)
    setSuccess(null)
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!name.trim()) {
      setError('Department name is required.')
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(null)

    const payload = {
      name: name.trim(),
      description: description.trim(),
    }

    try {
      if (editingId) {
        await api.patch(
          `/api/departments/${encodeURIComponent(editingId)}`,
          payload
        )

        setSuccess('Department updated successfully.')
      } else {
        await api.post('/api/departments', payload)

        setSuccess('Department created successfully.')
      }

      resetForm()
      await loadDepartments()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not save department.'
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(department: DepartmentStatRow) {
    const confirmed = window.confirm(
      `Delete the department "${department.name}"? This action cannot be undone.`
    )

    if (!confirmed) return

    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      await api.delete(
        `/api/departments/${encodeURIComponent(department.id)}`
      )

      setSuccess('Department deleted successfully.')
      await loadDepartments()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not delete department. Check whether complaints are assigned to it.'
      )
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--background)',
    color: 'var(--foreground)',
    fontSize: 12,
  } as const

  return (
    <div className="page-content">
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="eyebrow">Operations / Departments</div>
          <h1>Departments</h1>
          <p>
            Organize teams, assign responsibilities and track department performance.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            className="auth-button"
            onClick={() => {
              if (showForm) {
                resetForm()
              } else {
                setEditingId(null)
                setName('')
                setDescription('')
                setShowForm(true)
              }

              setError(null)
              setSuccess(null)
            }}
          >
            {showForm ? (
              <X size={15} style={{ marginRight: 7 }} />
            ) : (
              <UserPlus size={15} style={{ marginRight: 7 }} />
            )}

            {showForm ? 'Close' : 'Add Department'}
          </button>
        )}
      </div>

      {/* Feedback */}
      {error && (
        <div className="auth-error" role="alert">
          {error}
        </div>
      )}

      {success && (
        <div
          role="status"
          style={{
            padding: 12,
            marginBottom: 14,
            borderRadius: 8,
            background: 'var(--sidebar-accent)',
            color: 'var(--foreground)',
            fontSize: 12,
          }}
        >
          {success}
        </div>
      )}

      {/* Create / Edit Form */}
      {canManage && showForm && (
        <div
          className="table-card"
          style={{ padding: 20, marginBottom: 20 }}
        >
          <div style={{ marginBottom: 18 }}>
            <div className="eyebrow">Department configuration</div>

            <h2 style={{ fontSize: 16, margin: '5px 0' }}>
              {editingId ? 'Edit Department' : 'Create Department'}
            </h2>

            <p
              style={{
                fontSize: 12,
                color: 'var(--muted-foreground)',
              }}
            >
              Provide a name and an optional description for this department.
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 14,
              }}
            >
              <label>
                <span className="eyebrow">Department name *</span>

                <input
                  type="text"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Customer Support"
                  style={inputStyle}
                />
              </label>

              <label>
                <span className="eyebrow">Description</span>

                <input
                  type="text"
                  maxLength={300}
                  value={description}
                  onChange={(event) =>
                    setDescription(event.target.value)
                  }
                  placeholder="Describe this department"
                  style={inputStyle}
                />
              </label>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 10,
                marginTop: 18,
              }}
            >
              <button
                type="submit"
                className="auth-button"
                disabled={saving}
              >
                <Save size={14} style={{ marginRight: 7 }} />
                {saving
                  ? 'Saving...'
                  : editingId
                    ? 'Save Changes'
                    : 'Create Department'}
              </button>

              <button
                type="button"
                className="icon-button"
                onClick={resetForm}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Summary Cards */}
      <div
        className="metric-grid"
        style={{
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          marginBottom: 18,
        }}
      >
        <div className="metric-card">
          <div className="metric-head">
            <span>Total Departments</span>
          </div>
          <div className="metric-value">{rows.length}</div>
          <div className="metric-foot">
            <span className="delta">Organization teams</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Total Staff</span>
          </div>
          <div className="metric-value">
            {rows.reduce((total, item) => total + item.staffCount, 0)}
          </div>
          <div className="metric-foot">
            <span className="delta">Across departments</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-head">
            <span>Open Complaints</span>
          </div>
          <div className="metric-value">
            {rows.reduce(
              (total, item) => total + item.openComplaints,
              0
            )}
          </div>
          <div className="metric-foot">
            <span className="delta">Current department workload</span>
          </div>
        </div>
      </div>

      {/* Department Table */}
      <div className="table-card complaints-table">
        <div
          className="table-head"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <h3>All Departments</h3>
            <p>Department workload and performance</p>
          </div>

          <button
            type="button"
            className="icon-button"
            aria-label="Refresh departments"
            onClick={() => void loadDepartments()}
            disabled={loading}
          >
            <RefreshCw size={15} />
          </button>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Department</th>
                <th>Staff</th>
                <th>Total complaints</th>
                <th>Open</th>
                <th>Resolved</th>
                <th>Resolution rate</th>
                {canManage && <th>Actions</th>}
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={canManage ? 7 : 6}>
                    <div
                      style={{
                        padding: 20,
                        color: '#a2adba',
                        fontSize: 11,
                      }}
                    >
                      Loading departments...
                    </div>
                  </td>
                </tr>
              )}

              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 7 : 6}>
                    <div
                      style={{
                        padding: 30,
                        textAlign: 'center',
                        color: 'var(--muted-foreground)',
                      }}
                    >
                      <h3>No departments yet</h3>
                      <p style={{ fontSize: 12, marginTop: 7 }}>
                        Create your first department to organize your team.
                      </p>
                    </div>
                  </td>
                </tr>
              )}

              {rows.map((department) => (
                <tr key={department.id}>
                  <td>
                    <div className="customer-cell">
                      <div
                        className="avatar avatar-violet"
                        style={{
                          background: '#f0ecff',
                          color: '#8067d5',
                        }}
                      >
                        {initialsOf(department.name)}
                      </div>

                      <div>
                        <strong>{department.name}</strong>
                        <span>
                          {department.description || 'No description'}
                        </span>
                      </div>
                    </div>
                  </td>

                  <td>{department.staffCount}</td>

                  <td>{department.complaintCount}</td>

                  <td>
                    <StatusBadge
                      kind={
                        department.openComplaints > 0
                          ? 'in-progress'
                          : 'resolved'
                      }
                    >
                      {department.openComplaints}
                    </StatusBadge>
                  </td>

                  <td>{department.resolvedComplaints}</td>

                  <td>
                    {department.complaintCount > 0
                      ? `${Math.round(
                          (department.resolvedComplaints /
                            department.complaintCount) *
                            100
                        )}%`
                      : '—'}
                  </td>

                  {canManage && (
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                        }}
                      >
                        <button
                          type="button"
                          className="icon-button"
                          title="Edit department"
                          aria-label={`Edit ${department.name}`}
                          disabled={saving}
                          onClick={() => startEdit(department)}
                        >
                          <Save size={15} />
                        </button>

                        <button
                          type="button"
                          className="icon-button"
                          title="Delete department"
                          aria-label={`Delete ${department.name}`}
                          disabled={saving}
                          onClick={() => void handleDelete(department)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
