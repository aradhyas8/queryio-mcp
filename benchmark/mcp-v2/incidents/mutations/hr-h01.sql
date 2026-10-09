-- Buyer Arvind Rao (252) moves from Purchasing to Marketing on 2025-07-15, but purchase orders keep
-- being issued under his employee id afterwards (13 POs from 2025-07-15 on, already in the data).
UPDATE humanresources.employeedepartmenthistory SET enddate = '2025-07-14', modifieddate = '2025-07-14'
WHERE businessentityid = 252 AND departmentid = 5 AND enddate IS NULL;
INSERT INTO humanresources.employeedepartmenthistory (businessentityid, departmentid, shiftid, startdate, enddate, modifieddate)
VALUES (252, 4, 1, '2025-07-15', NULL, '2025-07-14');
UPDATE humanresources.employee SET jobtitle = 'Marketing Specialist', modifieddate = '2025-07-14' WHERE businessentityid = 252;
