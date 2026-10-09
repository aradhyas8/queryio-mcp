-- PO 3277 (Norstan Bike Hut, 2025-06-10) is entered a second time as PO 4013: same vendor, buyer, date,
-- lines, and totals. Only the original has receipt transactions.
INSERT INTO purchasing.purchaseorderheader (purchaseorderid, revisionnumber, status, employeeid, vendorid, shipmethodid, orderdate, shipdate, subtotal, taxamt, freight, modifieddate)
SELECT 4013, revisionnumber, status, employeeid, vendorid, shipmethodid, orderdate, shipdate, subtotal, taxamt, freight, '2025-06-24'
FROM purchasing.purchaseorderheader WHERE purchaseorderid = 3277;
INSERT INTO purchasing.purchaseorderdetail (purchaseorderid, purchaseorderdetailid, duedate, orderqty, productid, unitprice, receivedqty, rejectedqty, modifieddate)
SELECT 4013, 8845 + row_number() OVER (ORDER BY purchaseorderdetailid), duedate, orderqty, productid, unitprice, receivedqty, rejectedqty, '2025-06-24'
FROM purchasing.purchaseorderdetail WHERE purchaseorderid = 3277;
