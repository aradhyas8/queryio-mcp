-- Sport-100 Helmet, Red (707): a new standard cost of 130.8630 (10x the previous 13.0863) takes effect
-- 2025-05-01. List prices and the other helmets are unchanged.
UPDATE production.productcosthistory SET enddate = '2025-04-30', modifieddate = '2025-04-30' WHERE productid = 707 AND enddate IS NULL;
INSERT INTO production.productcosthistory (productid, startdate, enddate, standardcost, modifieddate)
VALUES (707, '2025-05-01', NULL, 130.8630, '2025-04-30');
UPDATE production.product SET standardcost = 130.8630, modifieddate = '2025-04-30' WHERE productid = 707;
