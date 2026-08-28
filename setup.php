<?php
// Run once from the command line: C:\xampp\php\php.exe setup.php
// Creates the local database if missing, applies schema.sql, and seeds demo data
// only if the users table is empty (mirrors src/seed.js's guard).

require __DIR__ . '/api/lib/db.php';

$host = env('DB_HOST', '127.0.0.1');
$port = env('DB_PORT', '3306');
$user = env('DB_USER', 'root');
$password = env('DB_PASSWORD', '');
$name = env('DB_NAME', 'vta_lms');

$bootstrap = new PDO("mysql:host=$host;port=$port;charset=utf8mb4", $user, $password, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$bootstrap->exec("CREATE DATABASE IF NOT EXISTS `$name` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
$bootstrap = null;

$pdo = db();
foreach (array_filter(array_map('trim', explode(';', file_get_contents(__DIR__ . '/schema.sql')))) as $statement) {
    if (stripos($statement, '--') === 0 || $statement === '') continue;
    $pdo->exec($statement);
}
echo "Schema applied to `$name`.\n";

$userCount = query('SELECT COUNT(*) AS n FROM users')[0]['n'];
if ($userCount > 0) {
    echo "Database already has users - skipping seed. Drop the $name database to reseed from scratch.\n";
    exit;
}

$courses = [
    ['Measurement & Quantification', 'Taking-off, measurement rules, abstracting and BOQ preparation.', 'fa-ruler-combined', 6],
    ['Estimation & Cost Planning', 'Estimating methods, cost plans, rates, valuation and tender pricing.', 'fa-file-invoice-dollar', 6],
    ['Contracts & Procurement', 'Procurement routes, contract administration, FIDIC, claims and disputes.', 'fa-file-contract', 5],
    ['CAD & Revit Architecture', '2D drafting, BIM workflows, Revit modeling and documentation.', 'fa-cubes', 4],
    ['Cost Control & Valuation', 'Interim valuations, variations, cash flow and final accounts.', 'fa-chart-line', 4],
    ['Surveying & Leveling', 'Practical site surveying, total station, leveling and setting out.', 'fa-compass-drafting', 3],
];

$studentNames = ["M.T.M. Aflal Mifly","I.M.Ahkam Ali","N.M.Ajab","I.M.Akkeel Ali","M.F.Fasly Ahamed","M.M.Rasath","M.A.R.Uwaisul Karni Ahamed","J.Vaksithan","M.H.Mohamed Ferose","I.M.Ihjas","R.A.Thakee","M.T.Mubasir","M.S.Ahamed Sumaith","M.R.Mohamed Rikkap","N.Safan Ahamed","S.Mohammed Navitkhan","A.Mohamed Ashfaak","N.Asjath Ahamed"];

$jobs = [
    ['Junior Quantity Surveyor', 'Internship', 'Colombo', '2026-08-30', 'Entry-level QS internship for NVQ students.'],
    ['Assistant Quantity Surveyor', 'Vacancy', 'Ampara', null, 'Diploma/NVQ welcome.'],
];

$hash = password_hash('password123', PASSWORD_BCRYPT);
$adminId = run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', ['Admin User', 'admin@vta.lk', $hash, 'admin'])['lastInsertRowid'];
$instructorId = run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', ['QS Instructor', 'instructor@vta.lk', $hash, 'instructor'])['lastInsertRowid'];
$studentId = run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', ['Demo Student', 'student@vta.lk', $hash, 'student'])['lastInsertRowid'];

$courseIds = [];
foreach ($courses as [$cname, $desc, $icon, $duration]) {
    $courseIds[] = run('INSERT INTO courses (name, description, icon, duration) VALUES (?, ?, ?, ?)', [$cname, $desc, $icon, $duration])['lastInsertRowid'];
}

run('INSERT INTO enrollments (user_id, course_id, progress) VALUES (?, ?, ?)', [$studentId, $courseIds[0], 40]);
run('INSERT INTO students (user_id, name, batch) VALUES (?, ?, ?)', [$studentId, 'Demo Student', 'NVQ-5']);

foreach ($studentNames as $sname) {
    run('INSERT INTO students (name, batch) VALUES (?, ?)', [$sname, 'NVQ-5']);
}

foreach ($jobs as [$title, $type, $location, $closesAt, $desc]) {
    run('INSERT INTO jobs (title, type, location, closes_at, description, posted_by) VALUES (?, ?, ?, ?, ?, ?)', [$title, $type, $location, $closesAt, $desc, $instructorId]);
}

echo "Seed complete. Demo accounts (password: password123):\n";
echo "  admin@vta.lk       (admin)\n";
echo "  instructor@vta.lk  (instructor)\n";
echo "  student@vta.lk     (student)\n";
