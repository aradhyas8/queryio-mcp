-- Linda Mitchell (276) is reassigned from Southwest (4) to Canada (6) effective 2025-02-01 in the territory
-- history and salesperson record, although her accounts stay in the Southwest. Her Southwest orders since
-- then are booked to Canada.
UPDATE sales.salesterritoryhistory SET enddate = '2025-01-31', modifieddate = '2025-01-31'
WHERE businessentityid = 276 AND territoryid = 4 AND enddate IS NULL;
INSERT INTO sales.salesterritoryhistory (businessentityid, territoryid, startdate, enddate, rowguid, modifieddate)
VALUES (276, 6, '2025-02-01', NULL, '3b8f1c2d-6a7e-4f90-8b1c-2d3e4f5a6b7c', '2025-01-31');
UPDATE sales.salesperson SET territoryid = 6, modifieddate = '2025-01-31' WHERE businessentityid = 276;
UPDATE sales.salesorderheader SET territoryid = 6 WHERE salespersonid = 276 AND orderdate >= '2025-02-01' AND territoryid = 4;
