import { query, queryOne, run, lastInsertId } from './sqlite.js'

const THRESHOLD_COLS = [
  'left_500','left_1k','left_2k','left_3k','left_4k','left_6k','left_8k',
  'right_500','right_1k','right_2k','right_3k','right_4k','right_6k','right_8k'
].join(', ')

export function getEmployeesByCompany(companyId) {
  return query(`
    SELECT e.*,
      b.baseline_id, b.test_date AS baseline_date,
      (SELECT t.classification FROM tests t WHERE t.employee_id = e.employee_id ORDER BY t.test_date DESC LIMIT 1) AS last_classification,
      (SELECT t.test_date     FROM tests t WHERE t.employee_id = e.employee_id ORDER BY t.test_date DESC LIMIT 1) AS last_test_date
    FROM employees e
    LEFT JOIN baselines b ON b.employee_id = e.employee_id AND b.archived = 0
    WHERE e.company_id = ?
    ORDER BY e.last_name, e.first_name
  `, [companyId])
}

export function getEmployee(employeeId) {
  return queryOne('SELECT * FROM employees WHERE employee_id = ?', [employeeId])
}

export function searchEmployees(q) {
  const like = `%${q}%`
  return query(`
    SELECT e.*, c.name AS company_name, c.province,
      (SELECT t.classification FROM tests t WHERE t.employee_id = e.employee_id ORDER BY t.test_date DESC LIMIT 1) AS last_classification,
      (SELECT t.test_date     FROM tests t WHERE t.employee_id = e.employee_id ORDER BY t.test_date DESC LIMIT 1) AS last_test_date
    FROM employees e
    JOIN companies c ON c.company_id = e.company_id
    WHERE e.status = 'active'
      AND (e.first_name LIKE ? OR e.last_name LIKE ? OR c.name LIKE ?)
    ORDER BY e.last_name, e.first_name
  `, [like, like, like])
}

export function createEmployee(data) {
  run(`INSERT INTO employees (company_id, first_name, last_name, dob, hire_date, job_title, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.company_id, data.first_name, data.last_name,
     data.dob ?? null, data.hire_date ?? null, data.job_title ?? null, data.status ?? 'active']
  )
  return lastInsertId()
}

export function updateEmployee(employeeId, data) {
  run(`UPDATE employees SET
    first_name = ?, last_name = ?, dob = ?, hire_date = ?, job_title = ?, status = ?
    WHERE employee_id = ?`,
    [data.first_name, data.last_name, data.dob ?? null,
     data.hire_date ?? null, data.job_title ?? null, data.status ?? 'active', employeeId]
  )
}

export function deleteEmployee(employeeId) {
  run('DELETE FROM employees WHERE employee_id = ?', [employeeId])
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export function getActiveBaseline(employeeId) {
  return queryOne(
    `SELECT * FROM baselines WHERE employee_id = ? AND archived = 0 ORDER BY test_date DESC LIMIT 1`,
    [employeeId]
  )
}

export function getAllBaselines(employeeId) {
  return query(
    `SELECT * FROM baselines WHERE employee_id = ? ORDER BY test_date DESC`,
    [employeeId]
  )
}

export function createBaseline(employeeId, testDate, thresholds) {
  // Archive existing baselines
  run(`UPDATE baselines SET archived = 1 WHERE employee_id = ? AND archived = 0`, [employeeId])

  run(`INSERT INTO baselines
    (employee_id, test_date, ${THRESHOLD_COLS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [employeeId, testDate, ...thresholdValues(thresholds)]
  )
  return lastInsertId()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function thresholdValues(t) {
  return [
    t.left_500  ?? null, t.left_1k  ?? null, t.left_2k  ?? null, t.left_3k  ?? null,
    t.left_4k   ?? null, t.left_6k  ?? null, t.left_8k  ?? null,
    t.right_500 ?? null, t.right_1k ?? null, t.right_2k ?? null, t.right_3k ?? null,
    t.right_4k  ?? null, t.right_6k ?? null, t.right_8k ?? null
  ]
}

/**
 * Build employee objects ready for packet inclusion.
 * Includes active baseline + last 3 periodic tests.
 */
export function buildPacketEmployees(companyId) {
  const fourYearsAgo = new Date()
  fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4)
  const cutoff = fourYearsAgo.toISOString().slice(0, 10)

  const employees = query(`
    SELECT e.*
    FROM employees e
    WHERE e.company_id = ? AND e.status = 'active'
      AND (
        (SELECT MAX(t.test_date) FROM tests t WHERE t.employee_id = e.employee_id) >= ?
        OR (SELECT COUNT(*) FROM tests t WHERE t.employee_id = e.employee_id) = 0
      )
    ORDER BY e.last_name, e.first_name
  `, [companyId, cutoff])

  return employees.map(emp => {
    const baseline   = getActiveBaseline(emp.employee_id)
    const priorTests = query(`
      SELECT t.*, h.adequacy AS hpd_adequacy
      FROM tests t
      LEFT JOIN hpd_assessments h ON h.test_id = t.test_id
      WHERE t.employee_id = ? AND t.test_type = 'Periodic'
      ORDER BY t.test_date DESC LIMIT 3
    `, [emp.employee_id])

    return {
      employee_id:  String(emp.employee_id),
      first_name:   emp.first_name,
      last_name:    emp.last_name,
      dob:          emp.dob,
      hire_date:    emp.hire_date,
      job_title:    emp.job_title,
      status:       emp.status,
      baseline:     baseline ? { ...baseline, thresholds: extractThresholds(baseline) } : null,
      prior_tests:  priorTests.map(t => ({
        test_id:        String(t.test_id),
        test_date:      t.test_date,
        classification: t.classification ? JSON.parse(t.classification) : null,
        thresholds:     extractThresholds(t)
      })),
      completed_tests: []
    }
  })
}

function extractThresholds(row) {
  return {
    left_500: row.left_500, left_1k: row.left_1k, left_2k: row.left_2k,
    left_3k: row.left_3k,  left_4k: row.left_4k, left_6k: row.left_6k, left_8k: row.left_8k,
    right_500: row.right_500, right_1k: row.right_1k, right_2k: row.right_2k,
    right_3k: row.right_3k,  right_4k: row.right_4k, right_6k: row.right_6k, right_8k: row.right_8k
  }
}
export function buildPacketEmployees(companyId) {
  return query(`
    SELECT e.*,
      l.name AS location_name,
      l.province,
      c.name AS company_name
    FROM employees e
    JOIN locations l ON l.location_id = e.location_id
    JOIN companies c ON c.company_id = l.company_id
    WHERE c.company_id = ?
      AND e.status = 'active'
    ORDER BY e.last_name, e.first_name
  `, [companyId])
}