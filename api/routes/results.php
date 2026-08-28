<?php
// Mirrors src/routes/results.js. $method and $segments are set by api/index.php.

function compute_gpa_grade(array $r): array {
    $avg = ((float) $r['measurement'] + (float) $r['estimation'] + (float) $r['contracts'] + (float) $r['cad']) / 4;
    $gpa = round(($avg / 100) * 4, 1);
    $grade = $avg >= 75 ? 'A' : ($avg >= 65 ? 'B+' : ($avg >= 55 ? 'B' : ($avg >= 45 ? 'C' : 'D')));
    return ['gpa' => $gpa, 'grade' => $grade];
}

if ($method === 'GET' && $segments === []) {
    require_auth();
    $rows = query('
        SELECT s.id AS student_id, s.name AS student_name,
          COALESCE(r.measurement, 0) AS measurement, COALESCE(r.estimation, 0) AS estimation,
          COALESCE(r.contracts, 0) AS contracts, COALESCE(r.cad, 0) AS cad
        FROM students s LEFT JOIN results r ON r.student_id = s.id
        ORDER BY s.name
    ');
    $result = array_map(fn($r) => array_merge($r, compute_gpa_grade($r)), $rows);
    json_response(['results' => $result]);
}

// Aggregated assignment + exam marks for every student enrolled in a course, optionally scoped to a module.
if ($method === 'GET' && $segments === ['module']) {
    $me = require_auth();
    $courseId = $_GET['course_id'] ?? null;
    $module = $_GET['module'] ?? null;
    $batch = $_GET['batch'] ?? null;
    if (!$courseId) error_response('course_id is required');

    if ($me['role'] === 'instructor') {
        $lecturer = query('SELECT * FROM lecturers WHERE user_id = ? AND course_id = ?', [$me['id'], $courseId])[0] ?? null;
        $allowedModules = $lecturer ? array_column(json_decode($lecturer['modules'] ?? '[]', true) ?: [], 'module') : [];
        $inScope = $lecturer && (!$module || in_array($module, $allowedModules, true));
        if (!$inScope) error_response('You can only view results for a course and module you are assigned to teach.', 403);
    }

    $effectiveBatch = $batch ?: null;
    if ($me['role'] === 'student') {
        $myStudent = query('SELECT batch FROM students WHERE user_id = ?', [$me['id']])[0] ?? null;
        $effectiveBatch = $myStudent ? $myStudent['batch'] : $effectiveBatch;
    }

    $assignClauses = ['course_id = ?']; $assignParams = [$courseId];
    if ($module) { $assignClauses[] = 'module = ?'; $assignParams[] = $module; }
    if ($effectiveBatch) { $assignClauses[] = '(batch IS NULL OR batch = ?)'; $assignParams[] = $effectiveBatch; }
    $assignments = query('SELECT id, title FROM assignments WHERE ' . implode(' AND ', $assignClauses) . ' ORDER BY created_at', $assignParams);

    $examClauses = ['course_id = ?']; $examParams = [$courseId];
    if ($module) { $examClauses[] = 'module = ?'; $examParams[] = $module; }
    if ($effectiveBatch) { $examClauses[] = '(batch IS NULL OR batch = ?)'; $examParams[] = $effectiveBatch; }
    $exams = query('SELECT id, title FROM exams WHERE ' . implode(' AND ', $examClauses) . ' ORDER BY created_at', $examParams);

    $studentClauses = ['en.course_id = ?']; $studentParams = [$courseId];
    if ($effectiveBatch) { $studentClauses[] = 's.batch = ?'; $studentParams[] = $effectiveBatch; }
    $students = query('
        SELECT u.id AS user_id, u.name AS student_name
        FROM enrollments en JOIN users u ON u.id = en.user_id
        LEFT JOIN students s ON s.user_id = u.id
        WHERE ' . implode(' AND ', $studentClauses) . '
        ORDER BY u.name
    ', $studentParams);

    $assignmentIds = array_column($assignments, 'id');
    $examIds = array_column($exams, 'id');

    $subRows = $assignmentIds ? query('SELECT assignment_id, student_user_id, grade FROM submissions WHERE assignment_id IN (' . implode(',', array_fill(0, count($assignmentIds), '?')) . ')', $assignmentIds) : [];
    $examSubRows = $examIds ? query('SELECT exam_id, student_user_id, grade FROM exam_submissions WHERE exam_id IN (' . implode(',', array_fill(0, count($examIds), '?')) . ')', $examIds) : [];

    $result = array_map(function ($s) use ($assignments, $exams, $subRows, $examSubRows) {
        $assignmentMarks = [];
        foreach ($assignments as $a) {
            $sub = null;
            foreach ($subRows as $r) if ($r['assignment_id'] == $a['id'] && $r['student_user_id'] == $s['user_id']) { $sub = $r; break; }
            $assignmentMarks[$a['id']] = $sub ? ['grade' => $sub['grade'], 'submitted' => true] : ['grade' => null, 'submitted' => false];
        }
        $examMarks = [];
        foreach ($exams as $e) {
            $sub = null;
            foreach ($examSubRows as $r) if ($r['exam_id'] == $e['id'] && $r['student_user_id'] == $s['user_id']) { $sub = $r; break; }
            $examMarks[$e['id']] = $sub ? ['grade' => $sub['grade'], 'submitted' => true] : ['grade' => null, 'submitted' => false];
        }
        return ['user_id' => $s['user_id'], 'student_name' => $s['student_name'], 'assignments' => $assignmentMarks, 'exams' => $examMarks];
    }, $students);

    $visibleResult = $me['role'] === 'student' ? array_values(array_filter($result, fn($r) => $r['user_id'] == $me['id'])) : $result;
    json_response(['assignments' => $assignments, 'exams' => $exams, 'students' => array_values($visibleResult)]);
}

if ($method === 'PUT' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $student = query('SELECT * FROM students WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$student) error_response('Student not found', 404);

    $body = request_body();
    $clamp = fn($v) => max(0, min(100, (float) ($v ?? 0)));
    $measurement = $clamp($body['measurement'] ?? null);
    $estimation = $clamp($body['estimation'] ?? null);
    $contracts = $clamp($body['contracts'] ?? null);
    $cad = $clamp($body['cad'] ?? null);

    run('
        INSERT INTO results (student_id, measurement, estimation, contracts, cad) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE measurement = VALUES(measurement), estimation = VALUES(estimation),
          contracts = VALUES(contracts), cad = VALUES(cad), updated_at = NOW()
    ', [$student['id'], $measurement, $estimation, $contracts, $cad]);

    $row = query('SELECT * FROM results WHERE student_id = ?', [$student['id']])[0];
    json_response(['result' => array_merge($row, ['student_name' => $student['name']], compute_gpa_grade($row))]);
}

error_response('Not found', 404);
