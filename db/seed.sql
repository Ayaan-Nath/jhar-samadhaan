-- ============================================================================
-- SIH 26043 — Jhar Samadhan | Comprehensive database seed
-- ----------------------------------------------------------------------------
-- Populates users, categories, complaints (384-dim embeddings + geo + every
-- workflow stage + duplicate clusters), claims, solutions, partnerships,
-- status_logs (full audit trails) and notifications with realistic Jharkhand
-- test data so every admin dashboard, marketplace UI and analytics API renders
-- live data out of the box.
--
-- Prerequisites (run in order):
--   1. psql -d <db> -f db/schema.sql        (creates extension vector + tables)
--   2. psql -d <db> -f db/seed.sql          (this file — TRUNCATEs first)
--
-- Deterministic demo ids (identity order after the TRUNCATE + RESTART):
--   id 1 = govt_admin  (open admin UIs with ?admin=1)
--   id 2 = CSR         (industry marketplace pid=2)
--   id 3 = Startup     (industry marketplace pid=3)
--   id 4 = MSME        (industry marketplace pid=4)
-- Complaints are inserted with a deterministic pseudo-random 384-dim test
-- vector (sf_test_vector) — real Sentence-BERT output can replace it by
-- calling the FastAPI /api/v1/embed service later.
-- ============================================================================

BEGIN;

-- ============================================================================
-- Reset (idempotent) — wipe prior seed data and restart identity sequences
-- ============================================================================
TRUNCATE TABLE
    notifications,
    status_logs,
    partnerships,
    solutions,
    claims,
    complaints,
    categories,
    users
RESTART IDENTITY CASCADE;

-- ============================================================================
-- Deterministic 384-dim test vector generator (dropped at the end of the seed)
-- ============================================================================
CREATE OR REPLACE FUNCTION sf_test_vector(p_seed INTEGER)
RETURNS vector
LANGUAGE plpgsql
AS $$
DECLARE
    parts TEXT := '';
    i     INTEGER;
    v     DOUBLE PRECISION;
BEGIN
    FOR i IN 1..384 LOOP
        -- deterministic pseudo-random value in [-0.1, 0.1)
        v := sin(p_seed * 12.9898 + i * 78.233) * 43758.5453;
        v := v - floor(v);
        parts := parts
                 || CASE WHEN i = 1 THEN '' ELSE ',' END
                 || round(((v - 0.5) * 0.2)::numeric, 6)::text;
    END LOOP;
    RETURN ('[' || parts || ']')::vector;
END;
$$;

-- ============================================================================
-- 1. CATEGORIES — fixed domain taxonomy
-- ============================================================================
INSERT INTO categories (code, name, description) VALUES
  ('AGR', 'Agriculture & Farmer Welfare', 'Crops, irrigation, MSP, subsidy and farmer-support issues'),
  ('WAT', 'Water & Sanitation', 'Drinking water, borewells, drainage and sanitation'),
  ('HLT', 'Health & Wellness', 'Hospitals, PHCs, vaccines, disease and public health'),
  ('EDU', 'Education & Skill Development', 'Schools, Anganwadis, midday meals and training'),
  ('PWR', 'Power & Energy', 'Electricity supply, transformers, solar and streetlights'),
  ('INF', 'Infrastructure & Roads', 'Roads, bridges, culverts, transport and public works'),
  ('SWM', 'Waste Management', 'Garbage collection, dumping yards and cleanliness'),
  ('OTH', 'Other / Citizen Services', 'Anything not covered by the domains above');

-- ============================================================================
-- 2. USERS — RBAC roles across the whole ecosystem
--    ids 1-4 are fixed demo accounts (admin / CSR / startup / MSME)
-- ============================================================================
INSERT INTO users (full_name, email, phone, role, org_name, district, allow_email_alerts) VALUES
  -- govt + industry partners (ids 1-4)
  ('Aarti Sinha',                  'aarti.sinha@jharkhand.gov.in',          '+91 94310 00001', 'govt_admin',  NULL,                 'Ranchi',     TRUE),
  ('CSR Desk, Tata Steel Foundation', 'csr.grants@tsf.example',             '+91 92340 11111', 'csr',         'Tata Steel Foundation', 'Jamshedpur', TRUE),
  ('Rahul Mehta',                  'rahul@agristack.example',               '+91 98350 22222', 'startup',     'AgriStack Labs',      'Bokaro',     TRUE),
  ('Suresh Yadav',                 'suresh@ranchimetal.example',            '+91 94310 33333', 'msme',        'Ranchi Metal Works',  'Ranchi',     TRUE),
  -- academic team leads — students (ids 5-12)
  ('Ananya Roy',                   'ananya.roy@nitjsr.example',             '+91 90000 00001', 'student',     NULL,                 'Jamshedpur', TRUE),
  ('Arjun Toppo',                  'arjun.toppo@bau.example',               '+91 90000 00002', 'student',     NULL,                 'Bokaro',     TRUE),
  ('Pooja Kumari',                 'pooja.kumari@xiss.example',             '+91 90000 00003', 'student',     NULL,                 'Ranchi',     TRUE),
  ('Rohan Verma',                  'rohan.verma@iitism.example',            '+91 90000 00004', 'student',     NULL,                 'Dhanbad',    TRUE),
  ('Sana Mirza',                   'sana.mirza@amity.example',              '+91 90000 00005', 'student',     NULL,                 'Ranchi',     TRUE),
  ('Kabir Dutta',                  'kabir.dutta@xlri.example',              '+91 90000 00006', 'student',     NULL,                 'Jamshedpur', TRUE),
  ('Devashish Sharma',             'devashish.sharma@rims.example',         '+91 90000 00007', 'student',     NULL,                 'Ranchi',     TRUE),
  ('Meera Das',                    'meera.das@nitjsr.example',              '+91 90000 00008', 'student',     NULL,                 'Jamshedpur', TRUE),
  -- NGO / institution leads (ids 13-16)
  ('Neelam Oraon',                 'neelam@greenjharkhand.example',         '+91 90000 00009', 'ngo',         'Green Jharkhand Foundation', 'Ranchi', TRUE),
  ('Imran Ansari',                 'imran@jhenergylab.example',             '+91 90000 00010', 'institution', 'Jharkhand Energy Lab', 'Dhanbad',  TRUE),
  ('Kavita Ekka',                  'kavita.ekka@xiss.example',              '+91 90000 00011', 'institution', 'XISS Ranchi',          'Ranchi',    TRUE),
  ('Ravi Bhushan',                 'ravi@setungo.example',                  '+91 90000 00012', 'ngo',         'Setu NGO',             'Deoghar',   TRUE),
  -- citizens (ids 17-28)
  ('Md Faizan',                    'faizan.cit@example.com',                '+91 91234 10001', 'citizen',     NULL, 'Ranchi',      TRUE),
  ('Sunita Devi',                  'sunita.devi@example.com',               '+91 91234 10002', 'citizen',     NULL, 'Gumla',       TRUE),
  ('Ramesh Mahto',                 'ramesh.mahto@example.com',              '+91 91234 10003', 'citizen',     NULL, 'Bokaro',      TRUE),
  ('Alok Kumar',                   'alok.kumar@example.com',                '+91 91234 10004', 'citizen',     NULL, 'Hazaribagh',  TRUE),
  ('Pinki Hembram',                'pinki.hembram@example.com',             '+91 91234 10005', 'citizen',     NULL, 'Latehar',     TRUE),
  ('Vijay Oraon',                  'vijay.oraon@example.com',               '+91 91234 10006', 'citizen',     NULL, 'Dhanbad',     TRUE),
  ('Rita Soren',                   'rita.soren@example.com',                '+91 91234 10007', 'citizen',     NULL, 'Deoghar',     TRUE),
  ('Kamal Paswan',                 'kamal.paswan@example.com',              '+91 91234 10008', 'citizen',     NULL, 'Jamshedpur',  TRUE),
  ('Deepa Minz',                   'deepa.minz@example.com',                '+91 91234 10009', 'citizen',     NULL, 'Giridih',     TRUE),
  ('Naresh Prasad',                'naresh.prasad@example.com',             '+91 91234 10010', 'citizen',     NULL, 'Palamu',      TRUE),
  ('Geeta Kumari',                 'geeta.kumari@example.com',              '+91 91234 10011', 'citizen',     NULL, 'Ramgarh',     TRUE),
  ('Sonu Mahato',                  'sonu.mahato@example.com',               '+91 91234 10012', 'citizen',     NULL, 'Chatra',      TRUE);

-- ============================================================================
-- 3. COMPLAINTS — geo-tagged, vector-embedded, spread across all workflow
--    stages and Jharkhand districts. Titles are unique and act as stable keys
--    for the claims/solutions/cluster statements that follow.
--    ord = identity order (ids 1..N); seed = sf_test_vector seed; dup children
--    share their cluster head's seed (=> identical embedding, similarity 1.0).
-- ============================================================================
INSERT INTO complaints
    (user_id, category_id, title, description, latitude, longitude, address,
     district, submission_mode, source_language, is_anonymous, embedding, status, created_at)
SELECT
    u.id,
    cat.id,
    v.title,
    v.description,
    v.lat,
    v.lng,
    v.address,
    v.district,
    v.mode,
    v.lang,
    v.is_anonymous,
    sf_test_vector(v.seed),
    v.status,
    now() - (interval '1 day' * v.age_days)
FROM (VALUES
    -- (ord, user_email, cat, title, description, lat, lng, address, district, mode, lang, anon, seed, status, age_days)
    ( 1, 'sunita.devi@example.com',  'WAT', 'Borewell water turns brown after monsoon rains',
         'The community borewell at the village square pumps brown, silt-laden water after every heavy rain. Children and elders have developed stomach issues this month.', 
         23.0410, 84.5390, 'Village square, Kamdara block', 'Gumla', 'text', 'en', FALSE, 101, 'resolved', 148),
    ( 2, 'kamal.paswan@example.com', 'WAT', 'Borewell at ward 9 turns brown too — same waterline',
         'Same muddy water issue reported from ward 9 which is on the same borewell waterline as the village square pump. Filtration unit is not maintained.',
         23.0442, 84.5455, 'Ward 9, Kamdara block', 'Gumla', 'text', 'en', FALSE, 101, 'in_progress', 139),
    ( 3, 'ramesh.mahto@example.com', 'AGR', 'Paddy crop pest outbreak — farmers need guidance',
         'Brown plant hopper infestation has spread across at least 40 acres of paddy. Farmers are spraying random pesticides because the extension officer visit is delayed.',
         23.6800, 86.1520, 'Chas block', 'Bokaro', 'text', 'hi', FALSE, 102, 'resolved', 132),
    ( 4, 'vijay.oraon@example.com',  'AGR', 'Koderma farmers report the same paddy pest after advisory delay',
         'Farmers in Koderma blocks confirm the same hopper damage on hybrid paddy varieties. Duplicate of the Bokaro outbreak — advisory needs broadcast in Hindi.',
         23.9920, 85.3627, 'Koderma block', 'Hazaribagh', 'text', 'hi', FALSE, 102, 'resolved', 96),
    ( 5, 'rita.soren@example.com',   'EDU', 'Anganwadi centre has no attendance records',
         'Anganwadi worker maintains no digital or paper attendance register; take-home ration distribution cannot be verified by ICDS supervisors for the last quarter.',
         23.9985, 85.3600, 'Barhi block centre', 'Hazaribagh', 'text', 'en', FALSE, 104, 'resolved', 120),
    ( 6, 'rita.soren@example.com',   'EDU', 'Anganwadi in Mandar block missing stock too',
         'A second centre in Mandar block has the same missing attendance and ration stock problem — reported so both centres can be onboarded together.',
         24.5000, 86.7000, 'Mandar block', 'Deoghar', 'text', 'en', FALSE, 104, 'resolved', 95),
    ( 7, 'pinki.hembram@example.com','PWR', 'Clinic power fails during the night, vaccines at risk',
         'The solar microgrid at the referral clinic trips every night after 10pm. Cold-chain vaccine storage switches to backup but fuel cost is unsustainable.',
         23.7450, 84.4700, 'Chandwa referral clinic', 'Latehar', 'voice', 'en', FALSE, 105, 'resolved', 141),
    ( 8, 'faizan.cit@example.com',   'INF', 'NH stretch potholes reported thrice, no repair',
         'A 2 km stretch of NH-33 near the Ranchi ring road has deep potholes. Three complaints have been filed since May but no repair order has been issued.',
         23.3550, 85.3100, 'NH-33, Kanke', 'Ranchi', 'text', 'en', FALSE, 106, 'resolved', 128),
    ( 9, 'vijay.oraon@example.com',  'INF', 'Same NH33 stretch in Dhanbad remains unrepaired',
         'Duplicate report for the NH-33 potholes — the section through Dhanbad district shows identical damage patterns and is still awaiting the same repair contract.',
         23.8000, 86.4300, 'NH-33, Govindpur', 'Dhanbad', 'text', 'en', FALSE, 106, 'resolved', 125),
    (10, 'kamal.paswan@example.com', 'INF', 'Potholes persist on NH33 near Jamshedpur',
         'Additional duplicate of the NH-33 pothole cluster near the Jamshedpur city entry. Motorcycle riders are at serious risk during night hours.',
         22.8100, 86.2050, 'NH-33, Tatanagar', 'Jamshedpur', 'text', 'en', FALSE, 106, 'in_progress', 118),
    (11, 'kamal.paswan@example.com', 'SWM', 'Garbage van skips lane every alternate week',
         'The ward garbage van skips this lane on alternate weeks. Bins overflow near the school gate and stray animals scatter waste on the road.',
         22.8000, 86.2000, 'Dimna Road, ward 12', 'Jamshedpur', 'text', 'en', FALSE, 107, 'resolved', 110),
    (12, 'sonu.mahato@example.com',  'SWM', 'Garbage van skips Dimna lane too',
         'Duplicate: same skipped-pickup pattern observed on the Dimna lane behind the community hall, likely the same van route gap.',
         22.8060, 86.2090, 'Dimna community hall', 'Jamshedpur', 'text', 'en', FALSE, 107, 'resolved', 104),
    (13, 'faizan.cit@example.com',   'PWR', 'Transformer on village feeder trips daily',
         'Distribution transformer on the Harnam feeder trips 3-4 times a day after 6pm, cutting power to 200 households and the dairy cooperative.',
         23.3500, 85.2900, 'Harnam feeder, Kanke', 'Ranchi', 'text', 'en', FALSE, 120, 'under_review', 95),
    (14, 'rita.soren@example.com',   'EDU', 'Anganwadi ration stock missing after festival',
         'Take-home ration stock for July is missing from the Anganwadi godown after the festival week. Parents have not received the promised nutrition kits.',
         24.4800, 86.7000, 'Jasidih block', 'Deoghar', 'text', 'hi', FALSE, 121, 'under_review', 91),
    (15, 'geeta.kumari@example.com', 'EDU', 'Block-level stock register also mismatched',
         'Duplicate of the missing ration issue — the block stock register at Jasidih shows a mismatch that matches the Anganwadi godown discrepancy.',
         24.4850, 86.7050, 'Jasidih block office', 'Deoghar', 'text', 'en', FALSE, 121, 'under_review', 88),
    (16, 'sonu.mahato@example.com',  'EDU', 'Third centre in the block reports shortfall',
         'Duplicate: a third centre under Jasidih block reports the same July ration shortfall, confirming the issue is at the block distribution level.',
         24.4750, 86.6950, 'Satsang Nagar centre', 'Deoghar', 'text', 'en', FALSE, 121, 'under_review', 84),
    (17, 'faizan.cit@example.com',   'EDU', 'School boundary wall collapsed after rains',
         'The rear boundary wall of the government middle school collapsed during the last storm. Classes continue next to the debris and there is no fencing.',
         23.3600, 85.3000, 'Dhurwa, Ranchi', 'Ranchi', 'image', 'en', FALSE, 122, 'under_review', 79),
    (18, 'ramesh.mahto@example.com', 'WAT', 'Market drain overflows into drinking-water line',
         'The market drain overflows every evening and its water seeps along the drinking-water pipeline trench, raising contamination risk for the whole bazaar.',
         23.6700, 86.1500, 'Phusro bazaar', 'Bokaro', 'text', 'en', FALSE, 123, 'under_review', 74),
    (19, 'alok.kumar@example.com',   'INF', 'Streetlights dark on Ranchi-Hazaribagh road',
         'All streetlights along the 3 km Hazaribagh bypass approach have been dark for a month. Night bus passengers feel unsafe at the pick-up points.',
         23.9900, 85.3700, 'Bypass approach', 'Hazaribagh', 'text', 'en', FALSE, 124, 'under_review', 71),
    (20, 'naresh.prasad@example.com','AGR', 'Stray cattle grazing on planted saplings',
         'Stray cattle are grazing on the saplings planted under the plantation drive along the Naxal-affected highway patch, undoing this year''s greening work.',
         24.0400, 84.0800, 'Highway patch, Mohammadganj', 'Palamu', 'text', 'en', FALSE, 125, 'under_review', 68),
    (21, 'deepa.minz@example.com',   'OTH', 'Stone crusher dust chokes village air',
         'A stone crusher operating without water sprinklers blankets the village in dust during working hours. Elderly residents report breathing difficulty.',
         24.1900, 86.3000, 'Beno village', 'Giridih', 'text', 'en', FALSE, 126, 'under_review', 66),
    (22, 'sonu.mahato@example.com',  'INF', 'Bus shelter roof missing at Koderma turn',
         'The bus shelter at the Koderma turn lost its roof panels in a storm and sharp edges now hang over the waiting bench.',
         24.2100, 84.8800, 'Koderma turn', 'Chatra', 'image', 'en', FALSE, 127, 'submitted', 60),
    (23, 'geeta.kumari@example.com', 'WAT', 'Low water pressure in Bhurkunda taps',
         'Household taps in Bhurkunda receive water only between 4am and 6am and at very low pressure. Summer rationing started early this year.',
         23.6300, 85.5300, 'Bhurkunda town', 'Ramgarh', 'voice', 'hi', FALSE, 128, 'submitted', 55),
    (24, 'deepa.minz@example.com',   'HLT', 'Stray dogs near government school',
         'A pack of five stray dogs rests at the school gate and has chased children twice this month. The school requests an anti-rabies drive.',
         24.1900, 86.2900, 'Middle school, Beno', 'Giridih', 'text', 'en', FALSE, 129, 'submitted', 50),
    (25, 'sunita.devi@example.com',  'HLT', 'No lady doctor available at PHC evening hours',
         'The primary health centre has no lady medical officer during evening OPD hours, forcing women patients to travel 30 km to the district hospital.',
         23.0400, 84.5400, 'Kamdara PHC', 'Gumla', 'voice', 'en', FALSE, 130, 'submitted', 45),
    (26, 'sonu.mahato@example.com',  'AGR', 'Seed subsidy not credited to farmer accounts',
         'Direct benefit transfer for the certified seed subsidy is pending for 60 farmers despite approval three months ago. Bank branch says no credit instruction received.',
         24.2000, 84.8700, 'Simaria block', 'Chatra', 'text', 'en', FALSE, 131, 'submitted', 40),
    (27, 'ramesh.mahto@example.com', 'SWM', 'Broken sewer line floods the street',
         'A broken sewer line at the chowk floods the street with sewage every evening. Passersby and shop owners report a strong stench throughout the day.',
         23.6700, 86.1500, 'Bermo chowk', 'Bokaro', 'text', 'en', FALSE, 132, 'submitted', 33),
    (28, 'rita.soren@example.com',   'INF', 'Bridge approach washed out after flood',
         'The southern approach of the small bridge over the Ajay river washed out after the flood. Villagers now wade through water with schoolchildren.',
         24.4700, 86.6800, 'Ajay river crossing', 'Deoghar', 'image', 'en', FALSE, 133, 'assigned', 158),
    (29, 'vijay.oraon@example.com',  'INF', 'Waterlogging on NH33 near Govindpur',
         'Rainwater accumulates across both carriageways near Govindpur for 3-4 days after rain. No culvert cleaning has been done this season.',
         23.8300, 86.4700, 'Govindpur', 'Dhanbad', 'text', 'en', FALSE, 134, 'assigned', 112),
    (30, 'geeta.kumari@example.com', 'AGR', 'PDS ration not reaching remote hamlet',
         'The ration shop vehicle stops 6 km short of the hamlet citing road condition. Elderly households have not received wheat for two months.',
         23.6200, 85.5400, 'Patratu valley hamlet', 'Ramgarh', 'text', 'hi', FALSE, 135, 'assigned', 103),
    (31, 'pinki.hembram@example.com','HLT', 'PHC refrigerator down, vaccines at risk',
         'The vaccine refrigerator at the PHC has been down for a week; a borrowed unit is stretched beyond capacity and temperature logs show excursions.',
         23.7400, 84.4600, 'Chandwa PHC', 'Latehar', 'text', 'en', FALSE, 136, 'assigned', 87),
    (32, 'deepa.minz@example.com',   'EDU', 'Midday meal quality complaints in schools',
         'Parents complain that midday meals lack vegetables on most days and the cook receives rations late. Two schools in the cluster share the complaint.',
         24.1850, 86.2950, 'Birni cluster', 'Giridih', 'text', 'en', FALSE, 137, 'assigned', 72),
    (33, 'alok.kumar@example.com',   'WAT', 'Chlorine dosing failing at water treatment plant',
         'The chlorine dosing pump at the Hazaribagh water treatment plant fails intermittently, and residual chlorine tests show zero on two days last week.',
         23.9900, 85.3600, 'Water works, Hazaribagh', 'Hazaribagh', 'text', 'en', FALSE, 138, 'assigned', 64),
    (34, 'faizan.cit@example.com',   'HLT', 'Ambulance response time too slow in outskirts',
         '108 ambulance took 70 minutes to reach a cardiac patient in the southern outskirts. There is no GPS-based dispatch feedback for the caller.',
         23.3100, 85.3200, 'Sukdega, outskirts', 'Ranchi', 'voice', 'en', FALSE, 139, 'in_progress', 150),
    (35, 'pinki.hembram@example.com','PWR', 'Solar microgrid battery faults at clinic',
         'Two of the six battery strings at the Chandwa microgrid show persistent under-voltage. The team is monitoring remotely but needs a site visit.',
         23.7450, 84.4710, 'Chandwa microgrid', 'Latehar', 'text', 'en', FALSE, 140, 'in_progress', 145),
    (36, 'kamal.paswan@example.com', 'AGR', 'Fertiliser stock app offline for two weeks',
         'The fertiliser availability app used by the cooperative is offline for two weeks, forcing farmers to travel for stock checks during sowing.',
         22.7900, 86.1900, 'Adityapur cooperative', 'Jamshedpur', 'text', 'en', FALSE, 141, 'in_progress', 125),
    (37, 'faizan.cit@example.com',   'SWM', 'Ward compost site odour unbearable',
         'The ward-level compost site has not been turned in a month and its odour now reaches the residential blocks 200 metres away.',
         23.3600, 85.2900, 'Kanke compost site', 'Ranchi', 'text', 'en', FALSE, 142, 'in_progress', 97),
    (38, 'rita.soren@example.com',   'PWR', 'School solar inverter keeps tripping',
         'The 5 kW solar inverter at the high school trips under half load every afternoon. Science lab equipment cannot run during study hours.',
         24.4900, 86.7100, 'High school, Jasidih', 'Deoghar', 'text', 'en', FALSE, 143, 'in_progress', 85),
    (39, 'faizan.cit@example.com',   'WAT', 'Water tanker scheduling patchy in summer',
         'Tanker supply to the hill-top settlement is irregular — three scheduled trips were missed in June, and residents queue for hours when tanks arrive.',
         23.3700, 85.3300, 'Hill-top settlement', 'Ranchi', 'text', 'en', FALSE, 144, 'resolved', 92),
    (40, 'kamal.paswan@example.com', 'HLT', 'Street dog vaccination camp needs repeat visit',
         'The anti-rabies camp vaccinated 40% of the mapped dogs; the remaining pack moved to the industrial area. A repeat visit is requested before monsoon.',
         22.8000, 86.2000, 'Industrial area, Tatanagar', 'Jamshedpur', 'text', 'en', FALSE, 145, 'resolved', 75),
    (41, 'sunita.devi@example.com',  'INF', 'Village approach culvert needs repair',
         'The culvert on the village approach road has cracked wing walls and a sagging slab; a loaded tractor crossing is a risk each harvest season.',
         23.0500, 84.5350, 'Approach road, Kamdara', 'Gumla', 'text', 'en', FALSE, 146, 'resolved', 140)
) AS v(ord, user_email, cat_code, title, description, lat, lng, address, district,
       mode, lang, is_anonymous, seed, status, age_days)
JOIN users u     ON u.email = v.user_email
JOIN categories cat ON cat.code = v.cat_code
ORDER BY v.ord;

-- ============================================================================
-- 4. AUDIT TRAILS — status_logs for every complaint, walking the strict linear
--    state machine Submitted -> Under Review -> Assigned -> In Progress ->
--    Resolved. Direct INSERT (no trigger) so each transition is written here.
-- ============================================================================
DO $$
DECLARE
    rec          RECORD;
    path         TEXT[] := ARRAY['submitted','under_review','assigned','in_progress','resolved'];
    idx          INTEGER;
    step_count   INTEGER;
    prev_status  TEXT;
    reason_text  TEXT;
    changed_who  BIGINT;
    log_at       TIMESTAMPTZ;
BEGIN
    FOR rec IN
        SELECT id, user_id, created_at, status FROM complaints ORDER BY id
    LOOP
        log_at := rec.created_at + interval '3 hours';
        step_count := 0;
        FOR idx IN 1..array_length(path, 1) LOOP
            step_count := step_count + 1;
            IF path[idx] = rec.status THEN
                EXIT;
            END IF;
        END LOOP;

        FOR idx IN 1..step_count LOOP
            prev_status := NULL;
            IF idx > 1 THEN
                prev_status := path[idx - 1];
            END IF;
            CASE path[idx]
                WHEN 'submitted'     THEN reason_text := 'Complaint submitted through the citizen app with geo-tag';
                WHEN 'under_review'  THEN reason_text := 'AI triage passed — routed for departmental review';
                WHEN 'assigned'      THEN reason_text := 'Adoption claim approved; team assigned to the complaint';
                WHEN 'in_progress'   THEN reason_text := 'Team started field work and prototype deployment';
                WHEN 'resolved'      THEN reason_text := 'Prototype verified — loop closed with the citizen';
                ELSE                     reason_text := 'Workflow update';
            END CASE;
            changed_who := CASE WHEN idx = 1 THEN rec.user_id ELSE 1 END;

            INSERT INTO status_logs
                (complaint_id, previous_status, new_status, changed_by, reason, created_at)
            VALUES
                (rec.id, prev_status, path[idx], changed_who, reason_text, log_at);

            log_at := log_at + interval '2 days' + (rec.id % 3) * interval '6 hours';
        END LOOP;
    END LOOP;
END $$;

-- ============================================================================
-- 5. DUPLICATE CLUSTERS — link duplicate reports to their cluster head and
--    store the semantic similarity score (children share the head's vector)
-- ============================================================================
UPDATE complaints SET
    cluster_id    = (SELECT id FROM complaints WHERE title = 'Borewell water turns brown after monsoon rains'),
    cluster_score = 0.951,
    embedding     = (SELECT embedding FROM complaints WHERE title = 'Borewell water turns brown after monsoon rains')
WHERE title = 'Borewell at ward 9 turns brown too — same waterline';

UPDATE complaints SET
    cluster_id    = (SELECT id FROM complaints WHERE title = 'Paddy crop pest outbreak — farmers need guidance'),
    cluster_score = 0.938,
    embedding     = (SELECT embedding FROM complaints WHERE title = 'Paddy crop pest outbreak — farmers need guidance')
WHERE title = 'Koderma farmers report the same paddy pest after advisory delay';

UPDATE complaints SET
    cluster_id    = (SELECT id FROM complaints WHERE title = 'Anganwadi centre has no attendance records'),
    cluster_score = 0.912,
    embedding     = (SELECT embedding FROM complaints WHERE title = 'Anganwadi centre has no attendance records')
WHERE title = 'Anganwadi in Mandar block missing stock too';

UPDATE complaints SET
    cluster_id    = (SELECT id FROM complaints WHERE title = 'NH stretch potholes reported thrice, no repair'),
    cluster_score = 0.947,
    embedding     = (SELECT embedding FROM complaints WHERE title = 'NH stretch potholes reported thrice, no repair')
WHERE title = 'Same NH33 stretch in Dhanbad remains unrepaired';

UPDATE complaints SET
    cluster_id    = (SELECT id FROM complaints WHERE title = 'NH stretch potholes reported thrice, no repair'),
    cluster_score = 0.903,
    embedding     = (SELECT embedding FROM complaints WHERE title = 'NH stretch potholes reported thrice, no repair')
WHERE title = 'Potholes persist on NH33 near Jamshedpur';

UPDATE complaints SET
    cluster_id    = (SELECT id FROM complaints WHERE title = 'Garbage van skips lane every alternate week'),
    cluster_score = 0.926,
    embedding     = (SELECT embedding FROM complaints WHERE title = 'Garbage van skips lane every alternate week')
WHERE title = 'Garbage van skips Dimna lane too';

UPDATE complaints SET
    cluster_id    = (SELECT id FROM complaints WHERE title = 'Anganwadi ration stock missing after festival'),
    cluster_score = 0.919,
    embedding     = (SELECT embedding FROM complaints WHERE title = 'Anganwadi ration stock missing after festival')
WHERE title = 'Block-level stock register also mismatched';

UPDATE complaints SET
    cluster_id    = (SELECT id FROM complaints WHERE title = 'Anganwadi ration stock missing after festival'),
    cluster_score = 0.884,
    embedding     = (SELECT embedding FROM complaints WHERE title = 'Anganwadi ration stock missing after festival')
WHERE title = 'Third centre in the block reports shortfall';

-- ============================================================================
-- 6. CLAIMS — academic/NGO adoptions (one per complaint, uq enforced)
-- ============================================================================
INSERT INTO claims
    (complaint_id, team_name, team_type, team_lead_id, institution_name,
     proposal, approval_status, reviewed_by, reviewed_at, created_at)
SELECT
    c.id,
    v.team_name,
    v.team_type,
    lead_user.id,
    v.institution,
    v.proposal,
    v.approval_status,
    CASE WHEN v.approval_status = 'pending' THEN NULL ELSE 1 END,
    CASE WHEN v.approval_status = 'pending' THEN NULL ELSE c.created_at + interval '9 days' END,
    c.created_at + interval '6 days'
FROM (VALUES
    -- (complaint title, team_name, team_type, lead_email, institution, proposal, approval_status)
    ('Borewell water turns brown after monsoon rains',
     'Team JalSetu', 'student', 'ananya.roy@nitjsr.example', 'NIT Jamshedpur',
     'IoT sensor raft for hand pumps with LoRaWAN telemetry, turbidity alerts to the pump operator and a public water-health dashboard.',
     'approved'),
    ('Paddy crop pest outbreak — farmers need guidance',
     'KrishiMitra', 'student', 'arjun.toppo@bau.example', 'Birsa Agricultural University',
     'Bhashini-integrated voice advisory assistant covering MSP, sowing windows and pest control, escalated to block extension officers.',
     'approved'),
    ('Anganwadi centre has no attendance records',
     'Team Poshan', 'student', 'pooja.kumari@xiss.example', 'XISS Ranchi',
     'Offline-first tablet app for Anganwadi workers to record attendance and ration stock, syncing district nutrition dashboards for ICDS.',
     'approved'),
    ('Clinic power fails during the night, vaccines at risk',
     'Team Urja', 'student', 'rohan.verma@iitism.example', 'IIT (ISM) Dhanbad',
     'Retrofit controller that monitors battery health, inverter load and clinic uptime, dispatching maintenance tickets before cold-chain outages.',
     'approved'),
    ('NH stretch potholes reported thrice, no repair',
     'Team SadakSetu', 'student', 'sana.mirza@amity.example', 'Amity University Ranchi',
     'Geo-tagged photo documentation pipeline from pothole inspection to contractor payment with a citizen-visible audit trail.',
     'approved'),
    ('Garbage van skips lane every alternate week',
     'Team SwachhPath', 'student', 'kabir.dutta@xlri.example', 'XLRI Jamshedpur',
     'Community-bin level ML routing for ward garbage vans, optimising fuel spend while closing every SWM complaint with pickup proof.',
     'approved'),
    ('Ambulance response time too slow in outskirts',
     'Team Sankalp Health', 'student', 'devashish.sharma@rims.example', 'RIMS Ranchi',
     'GPS dispatch optimiser with caller SMS feedback and hospital-capacity routing for the 108 network in peri-urban Ranchi.',
     'approved'),
    ('Solar microgrid battery faults at clinic',
     'Jharkhand Energy Lab', 'institution', 'imran@jhenergylab.example', 'Jharkhand Energy Lab',
     'Battery-string analytics with predictive under-voltage detection and automated maintenance ticket routing for off-grid clinics.',
     'approved'),
    ('Fertiliser stock app offline for two weeks',
     'Krishi Digital', 'student', 'meera.das@nitjsr.example', 'NIT Jamshedpur',
     'Resilient offline-first stock ledger for cooperative fertiliser availability with SMS fallback for feature-phone farmers.',
     'approved'),
    ('Ward compost site odour unbearable',
     'Swachh Jal Samiti', 'ngo', 'neelam@greenjharkhand.example', 'Green Jharkhand Foundation',
     'Community-managed compost turning schedule with odour monitoring and citizen reporting through the SIH platform.',
     'approved'),
    ('School solar inverter keeps tripping',
     'Poshan Grid', 'institution', 'kavita.ekka@xiss.example', 'XISS Ranchi',
     'Load-managed inverter controller for school solar systems protecting lab equipment and reporting runtime to the education department.',
     'approved'),
    ('Bridge approach washed out after flood',
     'RoadSafe Crew', 'student', 'sana.mirza@amity.example', 'Amity University Ranchi',
     'Drone survey and rapid damage-assess workflow producing engineering estimates for flood-damaged rural bridges within 48 hours.',
     'approved'),
    ('Waterlogging on NH33 near Govindpur',
     'Setu NGO', 'ngo', 'ravi@setungo.example', 'Setu NGO',
     'Community drain-mapping drives that schedule pre-monsoon culvert cleaning with photographic evidence for the highways division.',
     'approved'),
    ('PDS ration not reaching remote hamlet',
     'Krishi Utthan Samiti', 'institution', 'imran@jhenergylab.example', 'Jharkhand Energy Lab',
     'Last-mile ration delivery tracker with vehicle GPS logs and doorstep delivery scheduling for remote valley hamlets.',
     'approved'),
    ('PHC refrigerator down, vaccines at risk',
     'Green Jharkhand Foundation', 'ngo', 'neelam@greenjharkhand.example', 'Green Jharkhand Foundation',
     'Cold-chain equipment maintenance pass with temperature-log audits and a pooled spare-refrigerator registry across PHCs.',
     'approved'),
    ('Midday meal quality complaints in schools',
     'Shiksha Samvaad', 'ngo', 'ravi@setungo.example', 'Setu NGO',
     'Parent feedback kiosk for midday meals with daily vegetable-arrival verification and district-level quality scorecards.',
     'approved'),
    ('Chlorine dosing failing at water treatment plant',
     'JalDhara Labs', 'institution', 'kavita.ekka@xiss.example', 'XISS Ranchi',
     'Automatic chlorine-dosing controller with residual-chlorine telemetry and failover alarms for treatment-plant operators.',
     'approved'),
    ('Anganwadi ration stock missing after festival',
     'POSHAN Watch', 'ngo', 'ravi@setungo.example', 'Setu NGO',
     'Block-level ration reconciliation workflow that flags stock mismatches between godown registers and Anganwadi centres.',
     'pending')
) AS v(complaint_title, team_name, team_type, lead_email, institution, proposal, approval_status)
JOIN complaints c        ON c.title = v.complaint_title
JOIN users lead_user     ON lead_user.email = v.lead_email
ORDER BY c.id;

-- ============================================================================
-- 7. SOLUTIONS — versioned prototype iterations (submitted for verified
--    pipelines, approved for the marketplace, plus review-queue samples)
-- ============================================================================
INSERT INTO solutions
    (claim_id, iteration, title, summary, tech_stack, documentation,
     repository_url, prototype_url, status,
     submitted_by, submitted_at, reviewed_by, reviewed_at, review_comment)
SELECT
    cl.id,
    v.iteration,
    v.title,
    v.summary,
    v.tech_stack::jsonb,
    v.documentation::jsonb,
    v.repository_url,
    v.prototype_url,
    v.status,
    u.id,
    c.created_at + (interval '1 day' * v.days_after),
    CASE WHEN v.status = 'approved' THEN 1 ELSE NULL END,
    CASE WHEN v.status = 'approved' THEN c.created_at + (interval '1 day' * (v.days_after + 4)) ELSE NULL END,
    CASE WHEN v.status = 'approved' THEN 'Prototype verified with field evidence; documentation and demo links tested.' ELSE NULL END
FROM (VALUES
    -- (complaint title, iteration, solution title, summary, tech_stack, documentation, repo, demo, status, days_after)
    ('Borewell water turns brown after monsoon rains', 1,
     'IoT Water-Quality Sentinel for Hand Pumps',
     'Low-power sensor raft that mounts on community hand pumps and streams turbidity, pH and residual chlorine over LoRaWAN, with an SMS alert to the ward pump operator when contamination spikes.',
     '["ESP32","LoRaWAN","Python","PostgreSQL","pgvector"]',
     '[{"label":"Design doc","url":"https://docs.google.com/example/jalsetu"}]',
     'https://github.com/sih26043/jalsetu', 'https://demo.jharsamadhan.example/jalsetu',
     'approved', 24),
    ('Borewell water turns brown after monsoon rains', 2,
     'Water Sentinel v2 — chlorine residual + turbidity logger',
     'Second iteration adds an ORP sensor and a solar-rechargeable battery pack, cutting monthly site visits and enabling continuous residual-chlorine logging at the village square pump.',
     '["ESP32","LoRaWAN","Grafana","Solar MPPT"]',
     '[{"label":"v2 field report","url":"https://docs.google.com/example/jalsetu-v2"}]',
     'https://github.com/sih26043/jalsetu', 'https://demo.jharsamadhan.example/jalsetu',
     'approved', 45),
    ('Paddy crop pest outbreak — farmers need guidance', 1,
     'Kisan Sathi — Vernacular Advisory Chatbot',
     'Bhashini-integrated voice assistant that answers MSP, sowing-window and pest queries in Sadri and Hindi, routed to block extension officers for escalation.',
     '["Next.js","FastAPI","Bhashini","Sentence-BERT"]',
     '[{"label":"Demo walkthrough","url":"https://drive.google.com/example/kisan-sathi"}]',
     'https://github.com/sih26043/kisan-sathi', 'https://demo.jharsamadhan.example/kisan-sathi',
     'approved', 30),
    ('Anganwadi centre has no attendance records', 1,
     'Smart Anganwadi Attendance & Nutrition Tracker',
     'Offline-first tablet app for Anganwadi workers to record daily attendance and take-home rations, generating district-level nutrition dashboards for ICDS supervisors.',
     '["React Native","PWA","PostgreSQL"]',
     '[{"label":"ICDS onboarding note","url":"https://docs.google.com/example/poshan"}]',
     'https://github.com/sih26043/poshan-tracker', NULL,
     'approved', 34),
    ('Clinic power fails during the night, vaccines at risk', 1,
     'Solar Microgrid Health Monitor for Village Clinics',
     'Retrofit controller that tracks battery health, inverter load and clinic uptime across off-grid solar systems, dispatching maintenance tickets before outages hit cold-chain storage.',
     '["Arduino","Node.js","MQTT","Grafana"]',
     '[{"label":"Deployment guide","url":"https://docs.google.com/example/urja"}]',
     'https://github.com/sih26043/urja-monitor', 'https://demo.jharsamadhan.example/urja',
     'approved', 38),
    ('NH stretch potholes reported thrice, no repair', 1,
     'Digital Docket for Pothole-to-Contract Closure',
     'Geo-tagged photo documentation pipeline that lets junior engineers log pothole repairs from inspection to contractor payment, with an audit trail visible to citizens on the SIH platform.',
     '["Next.js","Leaflet","PostgreSQL","pgvector"]',
     '[{"label":"PWD workflow doc","url":"https://docs.google.com/example/sadaksetu"}]',
     'https://github.com/sih26043/sadaksetu', NULL,
     'approved', 32),
    ('Garbage van skips lane every alternate week', 1,
     'Route Planner for Decentralised Waste Collection',
     'Community-bin level ML routing for the ward garbage vans, optimising fuel spend while closing the loop on every SWM complaint with photographic proof of pickup.',
     '["Python","FastAPI","OR-Tools","Flutter"]',
     '[{"label":"Pilot route maps","url":"https://maps.example/swachhpath"}]',
     'https://github.com/sih26043/swachhpath', 'https://demo.jharsamadhan.example/swachhpath',
     'approved', 28),
    ('Ambulance response time too slow in outskirts', 1,
     'Sankalp Dispatch Optimiser — first field build',
     'GPS dispatch optimiser with caller SMS feedback and hospital-capacity routing for the 108 network; first field build deployed in two peri-urban zones.',
     '["Next.js","FastAPI","OpenRouteService","PostgreSQL"]',
     '[{"label":"Field trial notes","url":"https://docs.google.com/example/sankalp"}]',
     'https://github.com/sih26043/sankalp-dispatch', 'https://demo.jharsamadhan.example/sankalp',
     'submitted', 18),
    ('Solar microgrid battery faults at clinic', 1,
     'UrjaGuard Battery Analytics — submitted iteration',
     'Battery-string analytics with predictive under-voltage detection and automated maintenance ticket routing for off-grid clinics; awaiting verification.',
     '["Python","InfluxDB","FastAPI"]',
     '[{"label":"Diagnostics doc","url":"https://docs.google.com/example/urjaguard"}]',
     'https://github.com/sih26043/urjaguard', NULL,
     'submitted', 15),
    ('Fertiliser stock app offline for two weeks', 1,
     'Krishi Stock Ledger — revision requested',
     'Offline-first cooperative stock ledger with SMS fallback; reviewer asked for seeded demo data and an offline sync conflict report before re-verification.',
     '["Flutter","PostgreSQL","Twilio"]',
     '[{"label":"Sync design","url":"https://docs.google.com/example/krishi-ledger"}]',
     'https://github.com/sih26043/krishi-ledger', NULL,
     'revision_requested', 12),
    ('Ward compost site odour unbearable', 1,
     'Swachh Compost Operations — under review',
     'Community-managed compost turning schedule with odour monitoring; under departmental review for public health clearance.',
     '["React Native","Node.js"]',
     '[{"label":"Odour log sample","url":"https://docs.google.com/example/compost"}]',
     'https://github.com/sih26043/compost-ops', NULL,
     'under_review', 10),
    ('School solar inverter keeps tripping', 1,
     'Poshan Grid Load Controller — first iteration',
     'Load-managed inverter controller for school solar systems protecting lab equipment and reporting runtime; submitted for verification queue.',
     '["Arduino","ESPHome","MQTT"]',
     '[{"label":"Install photos","url":"https://drive.google.com/example/poshangrid"}]',
     'https://github.com/sih26043/poshangrid', NULL,
     'submitted', 8)
) AS v(complaint_title, iteration, title, summary, tech_stack, documentation,
       repository_url, prototype_url, status, days_after)
JOIN claims cl ON cl.complaint_id = (SELECT c.id FROM complaints c WHERE c.title = v.complaint_title)
JOIN complaints c ON c.id = cl.complaint_id
JOIN users u ON u.id = cl.team_lead_id
ORDER BY cl.id, v.iteration;

-- ============================================================================
-- 8. PARTNERSHIPS — CSR / startup / MSME pledges against approved solutions
--    (partner ids 2, 3, 4 match the marketplace demo accounts)
-- ============================================================================
INSERT INTO partnerships
    (solution_id, partner_user_id, pledge_type, amount_inr, title, description,
     contact_email, contact_phone, status, created_at)
SELECT
    s.id,
    p_user.id,
    v.pledge_type,
    v.amount_inr,
    v.title,
    v.description,
    v.contact_email,
    v.contact_phone,
    v.status,
    now() - (interval '1 day' * v.age_days)
FROM (VALUES
    -- (complaint title (approved solution), partner_email, pledge_type, amount, title, description, contact_email, phone, status, age_days)
    ('Clinic power fails during the night, vaccines at risk', 'csr.grants@tsf.example',
     'grant', 450000, '₹4.5L grant for 6 clinic retrofits',
     'Financial grant covering six cold-chain clinic retrofits including hardware, installation and one year of remote monitoring support.',
     'csr.grants@tsf.example', '+91 92340 11111', 'matched', 34),
    ('Borewell water turns brown after monsoon rains', 'rahul@agristack.example',
     'mentorship', NULL, 'AgriStack technical mentorship for sensor firmware',
     'Two embedded engineers mentoring the team on low-power LoRaWAN firmware, antenna design and field deployment for 12 weeks.',
     'rahul@agristack.example', '+91 98350 22222', 'active', 28),
    ('Garbage van skips lane every alternate week', 'suresh@ranchimetal.example',
     'pilot', 120000, 'Pilot deployment across two Jamshedpur wards',
     'Fabricated sensor mounts and route signage for pilot deployment in two wards plus in-kind fabrication support valued at ₹1.2 lakh.',
     'suresh@ranchimetal.example', '+91 94310 33333', 'active', 16),
    ('Paddy crop pest outbreak — farmers need guidance', 'csr.grants@tsf.example',
     'grant', 150000, '₹1.5L grant for vernacular voice advisory rollout',
     'Grant to expand the Hindi and Sadri advisory corpus and pilot voice-based pest alerts with 500 farmers in Bokaro district.',
     'csr.grants@tsf.example', '+91 92340 11111', 'pending', 10),
    ('Anganwadi centre has no attendance records', 'rahul@agristack.example',
     'mentorship', NULL, 'Cloud and data mentorship for nutrition dashboards',
     'Platform team will mentor on the offline sync architecture, data quality rules and district dashboard rollout for ICDS supervisors.',
     'rahul@agristack.example', '+91 98350 22222', 'pending', 8),
    ('NH stretch potholes reported thrice, no repair', 'suresh@ranchimetal.example',
     'grant', 100000, 'Material support for repair audit signage',
     'Grant towards durable audit signage and camera mounts used by the pothole documentation teams on NH-33.',
     'suresh@ranchimetal.example', '+91 94310 33333', 'active', 21)
) AS v(complaint_title, partner_email, pledge_type, amount_inr, title, description,
       contact_email, contact_phone, status, age_days)
JOIN solutions s ON s.claim_id = (SELECT cl.id FROM claims cl
                                  WHERE cl.complaint_id = (SELECT c.id FROM complaints c WHERE c.title = v.complaint_title))
                AND s.iteration = 1
JOIN users p_user ON p_user.email = v.partner_email
ORDER BY s.id;

-- ============================================================================
-- 9. NOTIFICATIONS — closed-loop alerts (emails for the future SMTP worker)
-- ============================================================================
-- 9a. Every resolved complaint -> its citizen reporter
INSERT INTO notifications (user_id, complaint_id, type, channel, subject, body, status)
SELECT
    c.user_id,
    c.id,
    'complaint_status',
    'email',
    'Your complaint is resolved — #' || c.id,
    'Good news! Your report "' || left(c.title, 120) || '" has been resolved and closed. Thank you for helping improve ' || c.district || '.',
    CASE WHEN c.id % 3 = 0 THEN 'sent' ELSE 'pending' END
FROM complaints c
WHERE c.status = 'resolved';

-- 9b. Approved adoption claims -> team leads
INSERT INTO notifications (user_id, complaint_id, type, channel, subject, body, status)
SELECT
    cl.team_lead_id,
    cl.complaint_id,
    'claim_status',
    'email',
    'Your adoption claim was approved — complaint #' || cl.complaint_id,
    'Team "' || cl.team_name || '" may now submit prototype iterations for "' || left(c.title, 120) || '".',
    'sent'
FROM claims cl
JOIN complaints c ON c.id = cl.complaint_id
WHERE cl.approval_status = 'approved';

-- 9c. Verified prototypes -> team leads (solution_review)
INSERT INTO notifications (user_id, complaint_id, type, channel, subject, body, status)
SELECT
    s.submitted_by,
    cl.complaint_id,
    'solution_review',
    'email',
    'Prototype approved — iteration #' || s.iteration,
    'Your prototype "' || s.title || '" was verified and approved. The linked complaint has been advanced for closure.',
    'sent'
FROM solutions s
JOIN claims cl ON cl.id = s.claim_id
WHERE s.status = 'approved' AND s.submitted_by IS NOT NULL;

-- 9d. Every partnership pledge -> govt admin + team lead
INSERT INTO notifications (user_id, complaint_id, type, channel, subject, body, status)
SELECT
    u.id,
    c.id,
    'partnership',
    'email',
    'New partnership pledge for prototype on complaint #' || c.id,
    p.title || ' — review and match it in the industry partnerships queue.',
    'pending'
FROM partnerships p
JOIN solutions s ON s.id = p.solution_id
JOIN claims cl    ON cl.id = s.claim_id
JOIN complaints c ON c.id = cl.complaint_id
JOIN LATERAL (SELECT unnest(ARRAY[1, cl.team_lead_id]) AS uid) x ON TRUE
JOIN users u     ON u.id = x.uid
WHERE u.is_active = TRUE
  AND u.allow_email_alerts = TRUE;

-- ============================================================================
-- Cleanup — drop the seed-only vector generator
-- ============================================================================
DROP FUNCTION IF EXISTS sf_test_vector(INTEGER);

-- ============================================================================
-- Summary (echoes row counts for a quick sanity check)
-- ============================================================================
SELECT 'users' AS tbl, count(*) FROM users
UNION ALL SELECT 'categories', count(*) FROM categories
UNION ALL SELECT 'complaints', count(*) FROM complaints
UNION ALL SELECT 'status_logs', count(*) FROM status_logs
UNION ALL SELECT 'claims', count(*) FROM claims
UNION ALL SELECT 'solutions', count(*) FROM solutions
UNION ALL SELECT 'partnerships', count(*) FROM partnerships
UNION ALL SELECT 'notifications', count(*) FROM notifications
ORDER BY tbl;

COMMIT;
