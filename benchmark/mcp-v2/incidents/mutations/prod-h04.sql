-- Mountain-200 Black, 38 (782): from 2025-04-01 the bill of materials uses the size-46 frame (746)
-- instead of the size-38 frame (747). Every work order since then is scrapped, recorded as
-- "Drill pattern incorrect".
UPDATE production.billofmaterials SET enddate = '2025-03-31', modifieddate = '2025-03-28' WHERE billofmaterialsid = 2314;
INSERT INTO production.billofmaterials (billofmaterialsid, productassemblyid, componentid, startdate, enddate, unitmeasurecode, bomlevel, perassemblyqty, modifieddate)
VALUES (3483, 782, 746, '2025-04-01', NULL, 'EA', 1, 1.00, '2025-03-28');
UPDATE production.workorder SET scrappedqty = orderqty, scrapreasonid = 4 WHERE productid = 782 AND startdate >= '2025-04-01';
