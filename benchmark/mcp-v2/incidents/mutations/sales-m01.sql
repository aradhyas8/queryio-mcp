-- Customer 12961 (Beaverton, Oregon; Northwest) has its territory changed to Southeast (5) in May 2025;
-- the June order inherits the wrong territory. The address is unchanged.
UPDATE sales.customer SET territoryid = 5, modifieddate = '2025-05-15' WHERE customerid = 12961;
UPDATE sales.salesorderheader SET territoryid = 5 WHERE salesorderid = 74780;
