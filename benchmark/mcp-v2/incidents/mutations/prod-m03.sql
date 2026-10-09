-- Bike Wash - Dissolver (877) price raised to 8.95 from 2025-06-01, but the previous price-history row
-- is left open, so two list prices are effective at once. June orders keep the old 7.95 price.
UPDATE production.product SET listprice = 8.95, modifieddate = '2025-05-30' WHERE productid = 877;
INSERT INTO production.productlistpricehistory (productid, startdate, enddate, listprice, modifieddate)
VALUES (877, '2025-06-01', NULL, 8.95, '2025-05-30');
